"use strict";
const { httpMedia } = require("../stream-policy");
const fail = () => Object.assign(new Error("Invalid DASH resource template or parameters"), { status: 422, code: "INVALID_DASH_TEMPLATE" });
function integer(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw fail();
  const text = String(value);
  if (!/^\d{1,20}$/.test(text) || BigInt(text) > 18446744073709551615n) throw fail();
  return BigInt(text).toString();
}
function render(tokens, values) {
  return tokens.map(token => typeof token === "string" ? token : values[token.variable].padStart(token.width, "0")).join("");
}
function compileTemplate(template, baseUrl, representation = {}) {
  if (typeof template !== "string" || !template || template.length > 4096 || !httpMedia(baseUrl) || baseUrl.length > 8192) throw fail();
  const tokens = [], variables = [];
  const expression = /\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0([1-9]\d*)d)?\$/g;
  let position = 0;
  const literal = value => { if (value.includes("$")) throw fail(); if (value) tokens.push(value); };
  for (const match of template.matchAll(expression)) {
    literal(template.slice(position, match.index)); position = match.index + match[0].length;
    if (match[0] === "$$") { tokens.push("$"); continue; }
    const name = match[1], width = Number(match[2] || 0);
    if (width > 20) throw fail();
    if (name === "RepresentationID") {
      if (width || typeof representation.id !== "string" || !representation.id || representation.id.length > 256) throw fail();
      tokens.push(encodeURIComponent(representation.id));
    } else if (name === "Bandwidth") tokens.push(integer(representation.bandwidth).padStart(width, "0"));
    else { tokens.push({ variable: name, width }); if (!variables.includes(name)) variables.push(name); }
  }
  literal(template.slice(position));
  let zero, one;
  try {
    zero = new URL(render(tokens, { Number: "0", Time: "0" }), baseUrl);
    one = new URL(render(tokens, { Number: "1", Time: "1" }), baseUrl);
  } catch { throw fail(); }
  if (zero.href.length > 8192 || one.href.length > 8192 || !httpMedia(zero.href) || !httpMedia(one.href) || zero.origin !== one.origin || zero.hash || one.hash) throw fail();
  return { version: 1, baseUrl, origin: zero.origin, tokens, variables };
}
function resolveTemplate(compiled, params) {
  if (compiled?.version !== 1 || !(params instanceof URLSearchParams)) throw fail();
  const values = {};
  for (const [name, value] of params) {
    if (!compiled.variables.includes(name) || Object.hasOwn(values, name)) throw fail();
    values[name] = integer(value);
  }
  if (compiled.variables.some(name => !Object.hasOwn(values, name))) throw fail();
  let url;
  try { url = new URL(render(compiled.tokens, values), compiled.baseUrl); }
  catch { throw fail(); }
  if (url.href.length > 8192 || url.origin !== compiled.origin || !httpMedia(url.href) || url.hash) throw fail();
  return url.href;
}
function templateQuery(compiled) { return compiled.variables.map(name => `${name}=$${name}$`).join("&"); }
module.exports = { compileTemplate, resolveTemplate, templateQuery };
