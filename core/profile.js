"use strict";
const CODECS = Object.freeze(["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"]);
function playbackProfile(value = {}) {
  const invalid = (detail = "expected a settings object") => { throw Object.assign(new Error(`Invalid playback profile: ${detail}`), { status: 400 }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const codecs = value.codecs || [];
  if (!Array.isArray(codecs) || codecs.some((codec) => !CODECS.includes(codec))) invalid("choose supported video codecs");
  const maxHeight = Number(value.maxHeight || 0);
  if (!Number.isInteger(maxHeight) || maxHeight < 0 || maxHeight > 8640) invalid("maximum resolution must be a whole number from 0 to 8640");
  const language = String(value.language || "").trim().toLowerCase();
  if (language && (language.length > 35 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(language))) invalid("preferred language must be a language code such as en or en-US");
  for (const key of ["hdr", "strictCapabilities"]) if (value[key] !== undefined && typeof value[key] !== "boolean") invalid(`${key} must be true or false`);
  return { codecs: [...new Set(codecs)], maxHeight, language, hdr: value.hdr !== false, strictCapabilities: value.strictCapabilities === true };
}
function constrainPlaybackContext(profile, context = {}) {
  const policy = playbackProfile(profile);
  const client = playbackProfile(context);
  const codecs = policy.codecs.length && client.codecs.length
    ? client.codecs.filter(codec => policy.codecs.includes(codec))
    : policy.codecs.length ? policy.codecs : client.codecs;
  // An empty intersection is incompatible, not the unrestricted [] profile.
  if (policy.codecs.length && client.codecs.length && !codecs.length) {
    throw Object.assign(new Error("Player codecs do not match the library playback profile"), { status: 422 });
  }
  const heights = [policy.maxHeight, client.maxHeight].filter(height => height > 0);
  return { ...context, codecs, maxHeight: heights.length ? Math.min(...heights) : 0,
    language: client.language || policy.language, hdr: policy.hdr && client.hdr,
    strictCapabilities: policy.strictCapabilities || client.strictCapabilities };
}
module.exports = { playbackProfile, constrainPlaybackContext, CODECS };
