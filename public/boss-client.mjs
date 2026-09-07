export class BossError extends Error {
  constructor(message, status) { super(message); this.name = "BossError"; this.status = status; }
}
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, cache: "no-store", referrerPolicy: "no-referrer" });
  const maximum = 8 * 1024 * 1024;
  if (Number(response.headers.get("content-length")) > maximum) {
    await response.body?.cancel();
    throw new BossError("Boss response exceeds 8 MiB", 413);
  }
  if (!response.body) throw new BossError("Invalid Boss response", response.status);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw new BossError("Boss response exceeds 8 MiB", 413);
      chunks.push(decoder.decode(part.value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  let data;
  try { data = JSON.parse(chunks.join("")); } catch { throw new BossError("Invalid Boss response", response.status); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new BossError("Invalid Boss response", response.status);
  if (!response.ok) throw new BossError(data.error || "Boss request failed", response.status);
  return data;
}
function checkDescriptor(data) {
  if (!data || data.format !== "boss-media-addon" || data.version !== 1 || typeof data.resources?.catalogue !== "string") throw new BossError("Unsupported Boss protocol version", 0);
  return data;
}
async function requestGuide(url, options) {
  const response = await fetch(url, { ...options, cache: "no-store", referrerPolicy: "no-referrer", redirect: "error" });
  const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!response.ok || !response.body || !["application/xml", "text/xml"].includes(type)) {
    await response.body?.cancel(); throw new BossError("Programme guide is unavailable or invalid", response.status);
  }
  return response;
}
export class BossClient {
  constructor(descriptor, invoke) { this.descriptor = descriptor; this.invoke = invoke; }
  playbackOptions(protocols) {
    if (protocols === undefined) return {};
    if (!Array.isArray(protocols) || !protocols.length || protocols.length > 3 || new Set(protocols).size !== protocols.length || protocols.some(value => !["http", "hls", "dash"].includes(value))) throw new BossError("Invalid playback protocols", 400);
    const negotiation = this.descriptor.playbackNegotiation;
    if (negotiation?.parameter !== "boss_protocols" || !Array.isArray(negotiation.protocols) || protocols.some(value => !negotiation.protocols.includes(value))) throw new BossError("Playback protocol negotiation is not supported", 422);
    return { boss_protocols: protocols.join(",") };
  }
  capabilityOptions(capabilities) {
    if (capabilities === undefined) return {};
    const parameters = { codecs: "boss_codecs", maxHeight: "boss_max_height", hdr: "boss_hdr", strictCapabilities: "boss_strict", language: "boss_language" };
    const codecs = ["h264", "hevc", "av1", "vp9", "mpeg2video", "mpeg4"];
    const invalid = () => new BossError("Invalid player capabilities", 400);
    if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) throw invalid();
    const result = {};
    const advertised = this.descriptor.playbackCapabilities;
    for (const [key, value] of Object.entries(capabilities)) {
      if (!Object.hasOwn(parameters, key)) throw invalid();
      if (value === undefined) continue;
      let normalized = value;
      if (key === "codecs") {
        if (!Array.isArray(value) || !value.length || value.length > codecs.length || new Set(value).size !== value.length || value.some(codec => !codecs.includes(codec))) throw invalid();
        normalized = value.join(",");
      } else if (key === "maxHeight") {
        if (!Number.isInteger(value) || value < 0 || value > 8640) throw invalid();
      } else if (key === "hdr" || key === "strictCapabilities") {
        if (typeof value !== "boolean") throw invalid();
      } else {
        if (typeof value !== "string" || value.length > 35) throw invalid();
        normalized = value.trim().toLowerCase();
        if (normalized && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) throw invalid();
      }
      if (advertised?.version !== 1 || advertised.parameters?.[key] !== parameters[key]
        || (key === "codecs" && (!Array.isArray(advertised.codecs) || value.some(codec => !advertised.codecs.includes(codec))))
        || (key === "maxHeight" && (!Number.isInteger(advertised.maximumHeight) || value > advertised.maximumHeight))) {
        throw new BossError("Player capability negotiation is not supported", 422);
      }
      result[parameters[key]] = String(normalized);
    }
    return result;
  }
  static async fromM3u(url, { signal } = {}) {
    const response = await fetch(url, { signal, cache: "no-store", referrerPolicy: "no-referrer" });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new BossError("Playlist request failed", response.status); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let prefix = "", bytes = 0;
    try {
      while (!prefix.includes("\n") && bytes < 8192) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value.subarray(0, 8192 - bytes); bytes += chunk.byteLength;
        prefix += decoder.decode(chunk, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const first = prefix.split(/\r?\n/, 1)[0];
    const link = first.startsWith("#EXTM3U") && first.match(/(?:^|\s)boss-addon-url="([^"]+)"/);
    if (!link) throw new BossError("This playlist does not advertise Boss support", 404);
    const target = new URL(link[1], response.url);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.origin !== new URL(response.url).origin) throw new BossError("Invalid Boss discovery URL", 400);
    return BossClient.fromAddon(target.href, { signal });
  }
  static async fromAddon(url, { signal, token } = {}) {
    const entry = new URL(url);
    if (!["http:", "https:"].includes(entry.protocol) || entry.username || entry.password) throw new BossError("Invalid Boss addon URL", 400);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const descriptor = checkDescriptor(await request(entry, { signal, headers, redirect: "error" }));
    return BossClient.connectDescriptor(descriptor, entry, token);
  }
  static async fromFile(file, { trustedOrigin, token, signal } = {}) {
    signal?.throwIfAborted();
    const maximum = 8 * 1024 * 1024;
    let text;
    if (typeof file === "string") {
      if (file.length > maximum || new TextEncoder().encode(file).byteLength > maximum) throw new BossError("Boss file exceeds 8 MiB", 413);
      text = file;
    } else if (file instanceof Uint8Array) {
      if (file.byteLength > maximum) throw new BossError("Boss file exceeds 8 MiB", 413);
      text = new TextDecoder("utf-8", { fatal: true }).decode(file);
    } else if (typeof Blob !== "undefined" && file instanceof Blob) {
      if (file.size > maximum) throw new BossError("Boss file exceeds 8 MiB", 413);
      text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
    } else throw new BossError("Expected a Boss file, UTF-8 bytes or text", 400);
    signal?.throwIfAborted();
    let descriptor;
    try { descriptor = checkDescriptor(JSON.parse(text)); } catch { throw new BossError("Invalid Boss file", 400); }
    let entry, trusted;
    try { entry = new URL(descriptor.addonUrl); trusted = new URL(trustedOrigin); } catch { throw new BossError("Boss file requires addonUrl and an explicitly trusted origin", 400); }
    if (!["http:", "https:"].includes(entry.protocol) || entry.username || entry.password || trusted.username || trusted.password || entry.origin !== trusted.origin) throw new BossError("Boss file is outside the trusted origin", 400);
    return BossClient.connectDescriptor(descriptor, entry, token);
  }
  static connectDescriptor(descriptor, entry, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return new BossClient(descriptor, (action, params, options) => {
      const endpoint = descriptor.resources[action === "search" ? "catalogue" : action];
      if (typeof endpoint !== "string") throw new BossError("Resource is not supported", 422);
      const target = new URL(endpoint.replace("{id}", encodeURIComponent(params.id || "")), entry);
      if (target.origin !== entry.origin || target.username || target.password) throw new BossError("Boss resource is outside the configured addon", 400);
      for (const [key, value] of Object.entries(params)) if (key !== "id" && value != null) target.searchParams.set(key, String(value));
      return (action === "guide" ? requestGuide : request)(target, { ...options, headers, redirect: "error" });
    });
  }
  static async fromXtream(server, username, password, { signal } = {}) {
    const endpoint = `${server.replace(/\/$/, "")}/boss_api`;
    const invoke = (action, params, options) => (action === "guide" ? requestGuide : request)(action === "guide" ? `${server.replace(/\/$/, "")}/xmltv.php` : endpoint, { ...options, method: "POST", body: new URLSearchParams({ username, password, action, ...Object.fromEntries(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])) }) });
    return new BossClient(checkDescriptor(await invoke("describe", {}, { signal })), invoke);
  }
  catalogue({ signal, ...params } = {}) { return this.invoke("catalogue", params, { signal }); }
  categories({ signal, ...params } = {}) {
    if (!this.descriptor.capabilities?.categories || !this.descriptor.resources.categories) throw new BossError("Categories are not supported", 422);
    return this.invoke("categories", params, { signal });
  }
  search(query, { signal, ...params } = {}) { return this.invoke("search", { ...params, search: query }, { signal }); }
  media(id, { signal } = {}) { return this.invoke("media", { id }, { signal }); }
  playback(id, { signal, protocols, capabilities } = {}) { return this.invoke("playback", { id, ...this.playbackOptions(protocols), ...this.capabilityOptions(capabilities) }, { signal }); }
  catchup(id, { start, end, signal, protocols, capabilities } = {}) { return this.invoke("catchup", { id, start, end, ...this.playbackOptions(protocols), ...this.capabilityOptions(capabilities) }, { signal }); }
  subtitles(id, { signal } = {}) { return this.invoke("subtitles", { id }, { signal }); }
  guide({ signal } = {}) {
    if (!this.descriptor.capabilities?.epg || !this.descriptor.resources.guide) throw new BossError("Programme guide is not supported", 422);
    return this.invoke("guide", {}, { signal });
  }
}
