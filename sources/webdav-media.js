"use strict";
const sax = require("sax");
const { externalIDs } = require("../core/model");

const VIDEO = /\.(mp4|mkv|m4v|webm|mov|avi|mpeg|mpg|ts|m2ts|mts|ogv|flv|3gp|m3u8)$/i;
const SUBTITLE = /\.(srt|vtt|ass|ssa)$/i;
const IMAGE = /\.(jpg|jpeg|png|webp)$/i;
const clean = value => String(value || "").replace(/[._]/g, " ").replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "");
function titleInfo(value) {
  const ids = {};
  let title = String(value || "").replace(/[\[{](imdb|tmdb|tvdb)(?:id)?[\s=:-]+(tt\d+|\d+)[\]}]/gi, (_, ns, id) => { ids[ns.toLowerCase()] = id; return ""; });
  const year = title.match(/[\[(]((?:19|20)\d{2})[\])]/)
    || title.match(/[\s._-]((?:19|20)\d{2})(?=$|[\s.)\]_-])/);
  if (year) title = title.slice(0, year.index) || title;
  title = title.split(/(?:^|[ ._-])(?:2160p|1080[pi]|720p|480p|4k|bluray|blu-ray|webrip|web-dl|hdtv|x26[45]|h26[45]|hevc|av1|remux)(?=$|[ ._-])/i)[0];
  return { title: clean(title) || clean(value), ...(year ? { year: Number(year[1]) } : {}), externalIDs: externalIDs(ids) };
}
function videoName(name) {
  const extension = name.match(VIDEO);
  if (!extension) return null;
  const stem = name.slice(0, -extension[0].length);
  const marker = /(?:^|[ ._-])s(\d{1,3})e(\d{1,4})(?:(?:-?e)(\d{1,4}))?(?=$|[ ._-])/i.exec(stem)
    || /(?:^|[ ._-])(\d{1,2})x(\d{1,4})(?=$|[ ._-])/i.exec(stem);
  if (!marker) return { ...titleInfo(stem), stem, container: extension[1].toLowerCase(), type: "movie" };
  const first = Number(marker[2]), last = marker[3] ? Number(marker[3]) : first;
  const numbers = last >= first && last - first < 20 ? Array.from({ length: last - first + 1 }, (_, i) => first + i) : [first];
  const prefix = titleInfo(stem.slice(0, marker.index));
  const suffix = titleInfo(stem.slice(marker.index + marker[0].length)).title;
  return { type: "episode", stem, container: extension[1].toLowerCase(), series: prefix,
    seasonNumber: Number(marker[1]), episodeNumbers: numbers, title: suffix || `Episode ${first}` };
}
function parseNfo(xml) {
  if (Buffer.byteLength(xml) > 1024 * 1024) throw new Error("NFO exceeds 1 MB");
  const parser = sax.parser(true, { trim: true, xmlns: true });
  const stack = []; let root; let nodes = 0;
  parser.ondoctype = () => { throw new Error("NFO document types are prohibited"); };
  parser.onerror = () => { throw new Error("Malformed NFO"); };
  parser.onopentag = tag => {
    if (++nodes > 10000 || stack.length >= 32) throw new Error("NFO structure exceeds bounds");
    const node = { name: tag.local.toLowerCase(), text: "", attributes: Object.fromEntries(Object.values(tag.attributes).map(a => [a.local, a.value])), children: [] };
    if (stack.length) stack.at(-1).children.push(node); else root = node;
    stack.push(node);
  };
  parser.ontext = parser.oncdata = value => { if (stack.length) stack.at(-1).text += value; };
  parser.onclosetag = () => stack.pop();
  parser.write(xml).close();
  if (!["movie", "tvshow", "episodedetails"].includes(root?.name)) return {};
  const node = (name, parent = root) => parent?.children.find(c => c.name === name);
  const text = (name, parent = root) => node(name, parent)?.text;
  const number = (name, parent = root) => text(name, parent) && Number.isFinite(Number(text(name, parent))) ? Number(text(name, parent)) : undefined;
  const ids = { imdb: text("imdbid") || text("imdb_id"), tmdb: text("tmdbid"), tvdb: text("tvdbid") };
  for (const child of root.children.filter(c => c.name === "uniqueid")) ids[child.attributes.type] = child.text;
  if (!ids.imdb && /^tt\d+$/.test(text("id") || "")) ids.imdb = text("id");
  const video = node("video", node("streamdetails", node("fileinfo")));
  const artwork = {};
  for (const thumb of root.children.filter(c => c.name === "thumb")) {
    const kind = thumb.attributes.aspect === "banner" ? null : thumb.attributes.aspect === "landscape" ? "thumbnail" : thumb.attributes.aspect || "poster";
    if (["poster", "thumbnail", "logo"].includes(kind) && !artwork[kind]) artwork[kind] = thumb.text;
  }
  const backdrop = text("thumb", node("fanart")); if (backdrop) artwork.backdrop = backdrop;
  return { type: { movie: "movie", tvshow: "series", episodedetails: "episode" }[root.name],
    title: text("title"), originalTitle: text("originaltitle"), year: number("year"),
    description: text("plot"), genres: root.children.filter(c => c.name === "genre").map(c => c.text).filter(Boolean),
    runtimeSeconds: number("runtime") === undefined ? undefined : number("runtime") * 60,
    rating: number("rating"), certification: text("mpaa"), releaseDate: text("premiered") || text("aired"),
    externalIDs: externalIDs(ids), seasonNumber: number("season"), episodeNumber: number("episode"),
    showTitle: text("showtitle"), artwork,
    stream: { codec: text("codec", video), resolution: number("height", video) ? { width: number("width", video), height: number("height", video) } : undefined } };
}
module.exports = { VIDEO, SUBTITLE, IMAGE, clean, titleInfo, videoName, parseNfo };
