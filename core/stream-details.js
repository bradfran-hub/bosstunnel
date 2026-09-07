"use strict";

const dimension = value => ["number", "string"].includes(typeof value) && Number.isInteger(Number(value)) && Number(value) > 0 && Number(value) <= 16384 ? Number(value) : undefined;
const nominalWidths = { 4320: 7680, 2160: 3840, 1440: 2560, 1080: 1920, 720: 1280 };
function completeResolution(value) {
  const width = dimension(value?.width), height = dimension(value?.height);
  if (width && height) return { width, height, ...(value.inferred === true ? { inferred: true } : {}) };
  if (!width && height && nominalWidths[height]) return { width: nominalWidths[height], height, inferred: true };
  return null;
}

// Extract display metadata without exposing provider URLs or raw release text.
function streamDetails(raw = {}) {
  const text = [raw.name, raw.title, raw.quality].filter(value => typeof value === "string").join(" ").slice(0, 4096);
  const pair = text.match(/\b(\d{3,5})[xX](\d{3,5})\b/);
  const height = dimension(raw.resolution?.height) || dimension(pair?.[2]) || Number(text.match(/\b(4320|2160|1440|1080|720|576|480|360)p\b/i)?.[1]) || (/\b8K\b/i.test(text) ? 4320 : /\b(?:4K|UHD)\b/i.test(text) ? 2160 : undefined);
  const width = dimension(raw.resolution?.width) || dimension(pair?.[1]);
  const quality = text.match(/\b(?:WEB[ .-]?DL|WEBRip|Blu[ .-]?Ray|BDRip|REMUX|HDTV|HDCAM|CAM|DVD(?:Rip)?)\b/i)?.[0].toUpperCase().replace(/[ .]/g, "-") || null;
  const codec = typeof raw.codec === "string" && /^[a-z0-9_.-]{1,24}$/i.test(raw.codec) ? raw.codec.toLowerCase() : /\b(?:HEVC|H[ .-]?265|x265)\b/i.test(text) ? "hevc" : /\b(?:H[ .-]?264|x264|AVC)\b/i.test(text) ? "h264" : /\bAV1\b/i.test(text) ? "av1" : null;
  const hdr = typeof raw.hdr === "string" && /^(?:HDR10\+?|HLG|Dolby Vision|DV|HDR)$/i.test(raw.hdr) ? raw.hdr : /\b(?:Dolby[ .-]?Vision|DoVi|DV)\b/i.test(text) ? "Dolby Vision" : /\bHDR10\+/i.test(text) ? "HDR10+" : /\bHDR10\b/i.test(text) ? "HDR10" : /\bHDR\b/i.test(text) ? "HDR" : raw.hdr ? "HDR" : null;
  return { quality, resolution: completeResolution({ width, height, inferred: raw.resolution?.inferred }), codec, hdr };
}

function qualityTags(candidate) {
  return [...new Set([
    candidate.resolution?.height ? `${candidate.resolution.height}p` : null,
    candidate.quality,
    candidate.codec ? candidate.codec.toUpperCase() : null,
    candidate.hdr,
    candidate.container ? candidate.container.toUpperCase() : null,
    ...candidate.audio.map(track => typeof track.codec === "string" && /^[a-z0-9+_.-]{1,24}$/i.test(track.codec) ? track.codec.toUpperCase() : null),
    ...candidate.languages.filter(language => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language))
  ].filter(Boolean))];
}
function qualityLabel(candidate) {
  const height = candidate.resolution?.height;
  return height === 2160 ? "4K UHD" : height === 4320 ? "8K UHD" : height ? `${height}p` : "Unknown quality";
}
module.exports = { streamDetails, qualityTags, qualityLabel, completeResolution };
