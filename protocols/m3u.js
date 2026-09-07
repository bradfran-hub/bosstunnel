"use strict";
const { createXtreamOutput } = require("./xtream");
const { primaryCategory } = require("./categories");
const safe = (value) => String(value || "").replace(/[\r\n"<>]/g, " ");
const xml = (value) => String(value || "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));
const time = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "").slice(0, 14) + " +0000";
async function* playlist(library, credentials) {
  const output = createXtreamOutput(library, credentials);
  yield `#EXTM3U x-tvg-url="${safe(library.links.epg)}" boss-addon-url="${safe(library.links.boss)}"\n`;
  for await (const media of library.items({ types: ["movie", "channel", "episode"] })) {
    const artwork = library.artwork(media);
    const id = library.engine.synthetic("xtream", media.id);
    const days = library.archiveDays(media);
    const archive = days > 0 ? ` catchup="xc" catchup-days="${days}"` : "";
    const parent = media.type === "episode" && library.graph.media(media.seriesId);
    const category = primaryCategory(library, parent || media);
    const group = category.id !== "1" ? category.name : media.type === "channel" ? "Live TV" : media.type === "episode" ? "Series" : "Movies";
    yield `#EXTINF:-1 tvg-id="${id}" tvg-logo="${safe(artwork.logo || artwork.poster)}"${archive} group-title="${safe(group)}",${safe(media.title)}\n${output.play(media)}\n`;
  }
}
async function* xmltv(library) {
  yield '<?xml version="1.0" encoding="UTF-8"?><tv generator-info-name="BossTunnel">';
  for await (const channel of library.items({ types: ["channel"] })) yield `<channel id="${library.engine.synthetic("xtream", channel.id)}"><display-name>${xml(channel.title)}</display-name></channel>`;
  let after = 0;
  while (true) {
    // Follow the ID cursor; a source-first index sorts the entire guide on each page.
    const events = library.graph.sql("SELECT e.* FROM EPGEvents e NOT INDEXED WHERE e.id>? AND e.source_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM SourceMappings sm WHERE sm.media_id=e.channel_id AND sm.source_id=e.source_id AND sm.active=1) ORDER BY e.id LIMIT 200").all(after, JSON.stringify(library.collection.sourceIds));
    if (!events.length) break;
    for (const event of events) yield `<programme channel="${library.engine.synthetic("xtream", event.channel_id)}" start="${time(event.starts_at)}" stop="${time(event.ends_at)}"><title>${xml(event.title)}</title><desc>${xml(event.description)}</desc></programme>`;
    after = events.at(-1).id;
    await new Promise(resolve => setImmediate(resolve));
  }
  yield "</tv>";
}
module.exports = { playlist, xmltv };
