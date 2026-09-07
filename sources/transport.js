"use strict";
const { JSONParser } = require("@streamparser/json");
const sax = require("sax");
const { httpMedia } = require("../stream-policy");
const { networkFetch: fetch } = require("../core/network");

async function request(url, options = {}) {
  if (!httpMedia(String(url))) throw new Error("Unsupported source URL");
  const response = await fetch(url, { ...options, redirect: "error", signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Source returned HTTP ${response.status}`); }
  return response;
}
async function json(url, options) {
  const response = await request(url, options);
  const chunks = []; let size = 0;
  for await (const part of response.body) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error("Metadata response exceeds 8 MB"); chunks.push(part); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function* jsonValues(url, { paths = ["$.*"], ...options } = {}) {
  const response = await request(url, options);
  const parser = new JSONParser({ paths, keepStack: false, stringBufferSize: 4096 });
  let pending = []; let bytesSinceValue = 0;
  parser.onValue = ({ value, stack }) => { if (stack.length > 64) throw new Error("Source JSON is too deeply nested"); pending.push(value); bytesSinceValue = 0; };
  for await (const chunk of response.body) {
    for (let offset = 0; offset < chunk.length; offset += 16384) {
      const part = chunk.subarray(offset, offset + 16384);
      bytesSinceValue += part.length;
      if (bytesSinceValue > 2 * 1024 * 1024) throw new Error("Individual source record exceeds 2 MB");
      parser.write(part);
      for (const value of pending) yield value;
      pending = [];
    }
  }
  if (!parser.isEnded) parser.end();
  for (const value of pending) yield value;
}
async function* lines(body, maxLine = 65536) {
  const decoder = new TextDecoder(); let pending = "";
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, end).replace(/\r$/, ""); pending = pending.slice(end + 1); if (line.length > maxLine) throw new Error("Source line too long"); yield line; }
    if (pending.length > maxLine) throw new Error("Source line too long");
  }
  pending += decoder.decode();
  if (pending) yield pending;
}
async function* xmlElements(body, element) {
  const parser = sax.parser(true, { xmlns: true, trim: true });
  parser.onerror = () => { throw new Error("Malformed source XML"); };
  let record = null; const stack = []; let pending = []; let recordSize = 0;
  parser.onopentag = (tag) => {
    if (stack.length >= 64) throw new Error("XML nesting exceeds 64 levels");
    const node = { name: tag.local, attributes: Object.fromEntries(Object.values(tag.attributes).map((a) => [a.local, a.value])), text: "", children: [] };
    if (record) stack.at(-1).children.push(node);
    if (!record && tag.local === element) { record = node; recordSize = 0; }
    if (record) {
      recordSize += 64 + tag.name.length + Object.entries(node.attributes).reduce((size, [key, value]) => size + key.length + value.length, 0);
      if (recordSize > 1024 * 1024) throw new Error("XML record exceeds 1 MB");
    }
    stack.push(node);
  };
  const text = (value) => { if (record) { recordSize += value.length; if (recordSize > 1024 * 1024) throw new Error("XML record exceeds 1 MB"); stack.at(-1).text += value; } };
  parser.ontext = text; parser.oncdata = text;
  parser.onclosetag = () => { const node = stack.pop(); if (node === record) { pending.push(record); record = null; } };
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    for (let offset = 0; offset < chunk.length; offset += 16384) {
      parser.write(decoder.decode(chunk.subarray(offset, offset + 16384), { stream: true }));
      for (const node of pending) yield node;
      pending = [];
    }
  }
  parser.write(decoder.decode()).close();
  for (const node of pending) yield node;
}
function child(node, name) { return node?.children.find((c) => c.name === name); }
function text(node, name) { return child(node, name)?.text || ""; }
async function* pages(records, { cursor, limit }) {
  let offset = 0; const skip = Number(cursor || 0); let batch = [];
  for await (const record of records) {
    if (offset++ < skip) continue;
    if (record) batch.push(record);
    if (batch.length === limit) { yield { items: batch, nextCursor: String(offset) }; batch = []; }
  }
  yield { items: batch, nextCursor: null };
}
module.exports = { request, json, jsonValues, lines, xmlElements, child, text, pages };
