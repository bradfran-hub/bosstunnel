"use strict";
const { xmlElements, text, request } = require("./transport");
async function probeXmltv(url) {
  let response, reader;
  try {
    response = await request(url, { signal: AbortSignal.timeout(8000) });
    reader = response.body.getReader();
    const parser = require("sax").parser(true, { xmlns: true }), decoder = new TextDecoder();
    const rootFound = new Error("XMLTV root checked");
    let valid = false, bytes = 0;
    parser.onopentag = tag => { valid = tag.local === "tv"; throw rootFound; };
    while (bytes < 65536) {
      const part = await reader.read(); if (part.done) break;
      const chunk = part.value.subarray(0, 65536 - bytes); bytes += chunk.byteLength;
      try { parser.write(decoder.decode(chunk, { stream: true })); }
      catch (error) { if (error === rootFound) return valid; throw error; }
    }
    return false;
  } catch { return false; }
  finally { if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); } else await response?.body?.cancel().catch(() => {}); }
}
function xmltvTime(value) {
  const match = String(value || "").trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\s*(?:([+-])(\d{2})(\d{2})|UTC|GMT))?$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00", sign = "+", oh = "00", om = "00"] = match;
  const local = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const date = new Date(local);
  if (date.getUTCFullYear() !== +year || date.getUTCMonth() !== +month - 1 || date.getUTCDate() !== +day || +hour > 23 || +minute > 59 || +second > 59 || +oh > 23 || +om > 59) return null;
  const time = local - (sign === "+" ? 1 : -1) * (+oh * 60 + +om) * 60000;
  return Number.isFinite(time) ? time : null;
}
async function* xmltv(body) {
  let records = 0;
  for await (const record of xmlElements(body, "programme")) {
    if (++records % 200 === 0) await require("node:timers/promises").setImmediate();
    const startsAt = xmltvTime(record.attributes.start), endsAt = xmltvTime(record.attributes.stop);
    if (startsAt == null || endsAt == null || endsAt <= startsAt) continue;
    yield { sourceKey: `${record.attributes.channel}:${startsAt}`, channelKey: record.attributes.channel, title: text(record, "title"), description: text(record, "desc"), startsAt, endsAt, metadata: { categories: record.children.filter((c) => c.name === "category").map((c) => c.text) } };
  }
}
module.exports = { xmltv, xmltvTime, probeXmltv };
