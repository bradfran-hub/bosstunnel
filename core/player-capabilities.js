"use strict";
const { playbackProfile, constrainPlaybackContext, CODECS } = require("./profile");
const PARAMETERS = Object.freeze({ codecs: "boss_codecs", maxHeight: "boss_max_height",
  hdr: "boss_hdr", strictCapabilities: "boss_strict", language: "boss_language" });
const invalid = () => Object.assign(new Error("Invalid player capabilities"), { status: 400 });

function capabilityDescriptor() {
  return { version: 1, parameters: { ...PARAMETERS }, codecs: [...CODECS], maximumHeight: 8640 };
}
function parseCapabilities(params) {
  const input = {};
  for (const [key, parameter] of Object.entries(PARAMETERS)) {
    const values = params.getAll(parameter);
    if (!values.length) continue;
    if (values.length !== 1) throw invalid();
    const value = values[0];
    if (key === "codecs") {
      input.codecs = value.split(",");
      if (!value || input.codecs.length > CODECS.length || new Set(input.codecs).size !== input.codecs.length) throw invalid();
    } else if (key === "maxHeight") {
      if (!/^\d{1,4}$/.test(value)) throw invalid();
      input.maxHeight = Number(value);
    } else if (key === "hdr" || key === "strictCapabilities") {
      if (!["true", "false"].includes(value)) throw invalid();
      input[key] = value === "true";
    } else input[key] = value;
  }
  const normalized = playbackProfile(input);
  return Object.fromEntries(Object.keys(input).map(key => [key, normalized[key]]));
}
function capabilityQuery(params, profile = {}) {
  const values = parseCapabilities(params);
  constrainPlaybackContext(profile, values);
  return Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [PARAMETERS[key], Array.isArray(value) ? value.join(",") : String(value)]));
}
module.exports = { PARAMETERS, capabilityDescriptor, parseCapabilities, capabilityQuery };
