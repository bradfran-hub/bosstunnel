"use strict";
const fail = message => Object.assign(new Error(message), { status: 422 });
const aliases = { avc: "h264", avc1: "h264", h265: "hevc", hvc1: "hevc", hev1: "hevc", matroska: "mkv" };
const normalized = value => { const key = String(value || "").toLowerCase(); return aliases[key] || key; };
function tokens(value) {
  if (value == null || value === "") return [];
  if (typeof value !== "string" || value.length > 512 || !/^[a-z0-9,._ -]+$/i.test(value)) throw fail("Invalid direct-play profile");
  return value.split(",").map(value => normalized(value.trim())).filter(Boolean);
}
function bounded(value, max = 64) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max || value.some(entry => !entry || typeof entry !== "object" || Array.isArray(entry))) throw fail("Invalid direct-play profile");
  return value;
}
function playbackRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Invalid playback request");
  for (const key of ["EnableDirectPlay", "EnableDirectStream", "EnableTranscoding", "AllowVideoStreamCopy", "AllowAudioStreamCopy", "AutoOpenLiveStream", "AlwaysBurnInSubtitleWhenTranscoding"]) if (input[key] != null && typeof input[key] !== "boolean") throw fail("Invalid playback option");
  for (const key of ["MaxStreamingBitrate", "MaxAudioChannels", "StartTimeTicks"]) if (input[key] != null && (!Number.isSafeInteger(input[key]) || input[key] < 0)) throw fail("Invalid playback limit");
  for (const key of ["AudioStreamIndex", "SubtitleStreamIndex"]) if (input[key] != null && (!Number.isSafeInteger(input[key]) || input[key] < -1)) throw fail("Invalid stream index");
  const profile = input.DeviceProfile;
  if (profile != null && (typeof profile !== "object" || Array.isArray(profile))) throw fail("Invalid device profile");
  for (const key of ["DirectPlayProfiles", "CodecProfiles", "ContainerProfiles", "SubtitleProfiles"]) bounded(profile?.[key]);
  for (const key of ["MaxStreamingBitrate", "MaxStaticBitrate"]) if (profile?.[key] != null && (!Number.isSafeInteger(profile[key]) || profile[key] < 0)) throw fail("Invalid device bitrate");
  return input;
}
function condition(candidate, condition, audio) {
  const facts = { Width: candidate.resolution?.width, Height: candidate.resolution?.height, VideoBitDepth: candidate.video?.bitDepth, VideoLevel: candidate.video?.level,
    VideoProfile: candidate.video?.profile, VideoFramerate: candidate.video?.frameRate, AudioChannels: audio?.channels, AudioBitrate: audio?.bitrate, AudioSampleRate: audio?.sampleRate,
    VideoBitrate: candidate.video?.bitrate, VideoRangeType: candidate.hdr || undefined };
  const actual = facts[condition.Property];
  if (actual == null) return condition.IsRequired === false;
  const values = String(condition.Value ?? "").split("|");
  if (condition.Condition === "Equals") return values.some(value => String(value).toLowerCase() === String(actual).toLowerCase());
  if (condition.Condition === "NotEquals") return values.every(value => String(value).toLowerCase() !== String(actual).toLowerCase());
  const value = Number(condition.Value);
  if (!Number.isFinite(value) || !Number.isFinite(Number(actual))) return false;
  return { LessThanEqual: Number(actual) <= value, GreaterThanEqual: Number(actual) >= value, LessThan: Number(actual) < value, GreaterThan: Number(actual) > value }[condition.Condition] === true;
}
function directPlayable(candidate, input) {
  playbackRequest(input);
  if (input.EnableDirectPlay === false || !["http", "hls"].includes(candidate.protocol)) return false;
  const profile = input.DeviceProfile;
  const matches = (restriction, value) => { const accepted = tokens(restriction); return !accepted.length || Boolean(value) && accepted.includes(normalized(value)); };
  const audios = candidate.audio || [];
  const caps = [input.MaxStreamingBitrate, profile?.MaxStreamingBitrate, profile?.MaxStaticBitrate].filter(value => value > 0);
  if (caps.length && (!candidate.bitrate || candidate.bitrate > Math.min(...caps))) return false;
  if (input.MaxAudioChannels > 0 && (!audios.length || audios.some(audio => !audio.channels || audio.channels > input.MaxAudioChannels))) return false;
  if (input.AudioStreamIndex >= 0 && !audios.some(audio => audio.index === input.AudioStreamIndex)) return false;
  if (profile && !bounded(profile.DirectPlayProfiles).some(entry => entry.Type === "Video" && matches(entry.Container, candidate.container)
    && matches(entry.VideoCodec, candidate.codec) && (!tokens(entry.AudioCodec).length || audios.length && audios.every(audio => matches(entry.AudioCodec, audio.codec))))) return false;
  for (const entry of bounded(profile?.ContainerProfiles)) {
    if (entry.Type && entry.Type !== "Video" || !matches(entry.Container, candidate.container)) continue;
    if (!bounded(entry.Conditions).every(value => condition(candidate, value))) return false;
  }
  for (const entry of bounded(profile?.CodecProfiles)) {
    const audio = ["VideoAudio", "Audio"].includes(entry.Type);
    if (!audio && entry.Type !== "Video") return false;
    for (const track of audio ? audios.length ? audios : [{}] : [null]) {
      if (!matches(entry.Codec, audio ? track.codec : candidate.codec) || !matches(entry.Container, candidate.container)) continue;
      if (!bounded(entry.ApplyConditions).every(value => condition(candidate, value, track))) continue;
      if (!bounded(entry.Conditions).every(value => condition(candidate, value, track))) return false;
    }
  }
  return true;
}
module.exports = { playbackRequest, directPlayable };
