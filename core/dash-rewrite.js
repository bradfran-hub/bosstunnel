"use strict";
const { parseDash, serializeDash, namespace } = require("./dash-document");
const { compileTemplate } = require("./dash-template");
const { httpMedia } = require("../stream-policy");
const fail = message => Object.assign(new Error(message), { status: 422, code: "UNSUPPORTED_DASH" });
const element = node => node && typeof node !== "string" && node.namespace === namespace;
const children = (node, name) => node.children.filter(child => element(child) && child.local === name);
const attribute = (node, name) => node.attributes.find(item => !item.namespace && item.local === name)?.value;
function set(node, name, value) {
  const item = node.attributes.find(item => !item.namespace && item.local === name);
  if (item) item.value = value;
  else node.attributes.push({ name, local: name, namespace: "", value });
}
function rewriteDash(text, documentUrl, { headers = {}, ticket, maxResources = 2048, maxOutputBytes = 4194304 } = {}) {
  if (!httpMedia(documentUrl) || typeof ticket !== "function") throw fail("Invalid DASH delivery context");
  const root = parseDash(text), documentOrigin = new URL(documentUrl).origin;
  const inspect = node => {
    if (typeof node === "string") return;
    if (node.attributes.some(item => item.namespace === "http://www.w3.org/XML/1998/namespace" && item.local === "base")) throw fail("DASH xml:base addressing is not supported");
    if (element(node) && ["ContentSteering", "UTCTiming", "SegmentSequence", "SubRepresentation"].includes(node.local)) throw fail("This DASH addressing feature is not supported yet");
    if (element(node) && node.local === "BaseURL" && (node.children.some(item => typeof item !== "string") || node.attributes.some(item => ["availabilityTimeOffset", "availabilityTimeComplete", "byteRange"].includes(item.local)))) throw fail("This DASH base URL feature is not supported yet");
    node.children.forEach(inspect);
  };
  inspect(root);
  let resources = 0, budget = Buffer.byteLength(text), representations = 0;
  const charge = value => { budget += Buffer.byteLength(value); if (budget > maxOutputBytes) throw fail("Rewritten DASH document exceeds its size limit"); };
  const copy = node => { const data = JSON.stringify(node); charge(data); return JSON.parse(data); };
  const resolve = (value, base) => {
    let url;
    try { url = new URL(value, base); } catch { throw fail("Invalid DASH resource URL"); }
    if (!httpMedia(url.href) || url.hash || url.href.length > 8192) throw fail("Unsupported DASH resource URL");
    return url.href;
  };
  const link = resource => {
    if (++resources > maxResources) throw fail("DASH resource count exceeds its limit");
    const origin = resource.dashTemplate?.origin || new URL(resource.url).origin;
    const value = ticket({ ...resource, headers: origin === documentOrigin ? { ...headers } : {} });
    if (typeof value !== "string" || !httpMedia(value)) throw fail("Invalid DASH ticket URL");
    charge(value); return value;
  };
  const merge = (parent, own) => {
    if (!parent || parent.local !== own.local) return copy(own);
    const combined = copy(parent), overridden = new Set(own.attributes.map(item => `${item.namespace}:${item.local}`));
    combined.attributes = combined.attributes.filter(item => !overridden.has(`${item.namespace}:${item.local}`)).concat(copy(own.attributes));
    const kinds = new Set(own.children.filter(element).map(item => item.local));
    combined.children = combined.children.filter(item => !element(item) || !kinds.has(item.local)).concat(copy(own.children));
    return combined;
  };
  const baseElement = (node, url) => ({ name: node.name.includes(":") ? `${node.name.split(":")[0]}:BaseURL` : "BaseURL", local: "BaseURL", namespace, attributes: [], children: [url] });
  const walk = (node, inheritedBase, inheritedAddress) => {
    if (!element(node)) return;
    const bases = children(node, "BaseURL");
    if (bases.length > 1) throw fail("Multiple DASH base URL alternatives are not supported yet");
    const base = bases.length ? resolve(bases[0].children.map(item => typeof item === "string" ? item : "").join("").trim(), inheritedBase) : inheritedBase;
    const addresses = node.children.filter(item => element(item) && ["SegmentTemplate", "SegmentList", "SegmentBase"].includes(item.local));
    if (addresses.length > 1) throw fail("Ambiguous DASH segment addressing");
    const address = addresses.length ? merge(inheritedAddress, addresses[0]) : inheritedAddress;
    node.children = node.children.filter(item => !element(item) || !["BaseURL", "SegmentTemplate", "SegmentList", "SegmentBase", "Location", "PatchLocation"].includes(item.local));
    if (node.local === "Representation") {
      representations++;
      const descriptor = address ? copy(address) : null;
      if (descriptor?.local === "SegmentTemplate") {
        if (!attribute(descriptor, "media")) throw fail("DASH segment template has no media resource");
        for (const name of ["media", "initialization", "index", "bitstreamSwitching"]) {
          const value = attribute(descriptor, name);
          if (value) set(descriptor, name, link({ dashTemplate: compileTemplate(value, base, { id: attribute(node, "id"), bandwidth: attribute(node, "bandwidth") }) }));
        }
      } else {
        if (!descriptor || descriptor.local === "SegmentBase") {
          if (base === documentUrl || new URL(base).pathname.endsWith("/")) throw fail("DASH representation has no media base URL");
          node.children.unshift(baseElement(node, link({ url: base })));
        }
        if (descriptor?.local === "SegmentList") for (const segment of children(descriptor, "SegmentURL")) {
          set(segment, "media", link({ url: resolve(attribute(segment, "media") || "", base) }));
          if (attribute(segment, "index")) set(segment, "index", link({ url: resolve(attribute(segment, "index"), base) }));
        }
      }
      if (descriptor) {
        for (const child of descriptor.children.filter(item => element(item) && ["Initialization", "RepresentationIndex", "BitstreamSwitching"].includes(item.local))) set(child, "sourceURL", link({ url: resolve(attribute(child, "sourceURL") || "", base) }));
        node.children.push(descriptor);
      }
      return;
    }
    for (const child of node.children) if (element(child)) walk(child, base, address);
  };
  walk(root, documentUrl, null);
  if (!representations) throw fail("DASH document contains no representations");
  const result = serializeDash(root);
  if (Buffer.byteLength(result) > maxOutputBytes) throw fail("Rewritten DASH document exceeds its size limit");
  return result;
}
module.exports = { rewriteDash };
