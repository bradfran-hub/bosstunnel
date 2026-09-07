"use strict";
const { json } = require("./transport");
const titleKey = (title) => String(title || "").replace(/\s*\(\d{4}\)\s*$/, "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
async function cinematographicMetadata(media, { signal, caches, baseUrl = process.env.BOSS_CINEMETA_URL || "https://v3-cinemeta.strem.io" } = {}) {
  if (!["movie", "series"].includes(media.type)) return null;
  const root = new URL(baseUrl);
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password) throw new Error("Invalid metadata provider URL");
  async function get(path) {
    const url = new URL(path, `${root.href.replace(/\/$/, "")}/`).href;
    const key = `cinemeta:${url}`;
    const cached = caches?.sourceResponses.get(key);
    if (cached) return cached;
    const result = await json(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    caches?.sourceResponses.set(key, result, 3600000);
    return result;
  }
  let id = media.externalIDs?.imdb;
  if (!/^tt\d+$/.test(id || "")) {
    if (!media.year || !media.title) return null;
    const result = await get(`catalog/${media.type}/top/${new URLSearchParams({ search: media.title.replace(/\s*\(\d{4}\)\s*$/, "") })}.json`);
    const matches = new Map((result.metas || []).filter((item) => /^tt\d+$/.test(item.id || "") && titleKey(item.name) === titleKey(media.title) && Number(String(item.releaseInfo || item.year || "").slice(0, 4)) === Number(media.year)).map((item) => [item.id, item]));
    if (matches.size !== 1) return null;
    id = matches.keys().next().value;
  }
  const result = await get(`meta/${media.type}/${encodeURIComponent(id)}.json`);
  if (!result.meta || result.meta.id !== id || result.meta.type && result.meta.type !== media.type) return null;
  return result.meta;
}
module.exports = { cinematographicMetadata };
