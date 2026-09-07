"use strict";
const sax = require("sax");
const namespace = "urn:mpeg:dash:schema:mpd:2011";
const invalid = message => Object.assign(new Error(message), { status: 422, code: "INVALID_DASH" });
function parseDash(text, { maxBytes = 2097152, maxNodes = 50000, maxDepth = 64 } = {}) {
  if (typeof text !== "string" || Buffer.byteLength(text) > maxBytes) throw invalid("DASH document exceeds its size limit");
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const stack = [];
  let root, count = 0;
  parser.ondoctype = () => { throw invalid("DASH document type declarations are not supported"); };
  parser.onerror = () => { throw invalid("Malformed DASH document"); };
  parser.onopentag = tag => {
    if (++count > maxNodes || stack.length >= maxDepth) throw invalid("DASH document exceeds its structure limit");
    if (tag.local === "ContentProtection") throw invalid("Protected DASH content is not supported");
    const attributes = Object.values(tag.attributes).map(attribute => ({ name: attribute.name, local: attribute.local, namespace: attribute.uri, value: attribute.value }));
    if (attributes.some(attribute => attribute.namespace === "http://www.w3.org/1999/xlink")) throw invalid("Remote DASH document fragments are not supported");
    const node = { name: tag.name, local: tag.local, namespace: tag.uri, attributes, children: [] };
    if (stack.length) stack.at(-1).children.push(node);
    else {
      if (root || tag.local !== "MPD" || tag.uri !== namespace) throw invalid("Expected a DASH MPD document");
      root = node;
    }
    stack.push(node);
  };
  const content = value => {
    if (stack.length) {
      const children = stack.at(-1).children;
      if (typeof children.at(-1) === "string") children[children.length - 1] += value;
      else { if (++count > maxNodes) throw invalid("DASH document exceeds its structure limit"); children.push(value); }
    } else if (value.trim()) throw invalid("Unexpected text outside DASH document");
  };
  parser.ontext = content;
  parser.oncdata = content;
  parser.onclosetag = () => stack.pop();
  try { parser.write(text).close(); }
  catch (error) { if (error.code === "INVALID_DASH") throw error; throw invalid("Malformed DASH document"); }
  if (!root || stack.length) throw invalid("Incomplete DASH document");
  return root;
}
const escape = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attributeValue = value => escape(value).replace(/\t/g, "&#9;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
function serializeDash(root) {
  const write = node => typeof node === "string" ? escape(node) : `<${node.name}${node.attributes.map(attribute => ` ${attribute.name}="${attributeValue(attribute.value)}"`).join("")}>${node.children.map(write).join("")}</${node.name}>`;
  return `<?xml version="1.0" encoding="UTF-8"?>${write(root)}`;
}
module.exports = { parseDash, serializeDash, namespace };
