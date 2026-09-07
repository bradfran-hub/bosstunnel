"use strict";
const { resolveTemplate, templateQuery } = require("./dash-template");
const denied = () => Object.assign(new Error("Resource expired or revoked"), { status: 403 });
function sealTicket(graph, collectionId, sourceId, resource, expires) {
  const collection = graph.collection(collectionId), source = graph.source(sourceId);
  if (!collection?.sourceIds.includes(sourceId) || !source?.enabled || !Number.isSafeInteger(expires) || expires <= graph.clock()) throw denied();
  const payload = { collectionId, collectionRevision: collection.revision, sourceId, revision: source.revision, resource, expires };
  const encoded = Buffer.from(graph.secrets.seal(payload)).toString("base64url");
  const query = resource.dashTemplate ? templateQuery(resource.dashTemplate) : "";
  return encoded + (query ? `?${query}` : "");
}
function openTicket(graph, collectionId, encoded, params = new URLSearchParams()) {
  let value;
  try { value = graph.secrets.open(Buffer.from(encoded, "base64url").toString()); }
  catch { throw denied(); }
  const collection = graph.collection(collectionId), source = graph.source(value?.sourceId);
  if (!collection || value?.collectionId !== collectionId || value.collectionRevision !== collection.revision || !Number.isSafeInteger(value.expires) || value.expires <= graph.clock() || !source?.enabled || source.revision !== value.revision || !collection.sourceIds.includes(value.sourceId) || !value.resource || typeof value.resource !== "object") throw denied();
  if (value.resource.dashTemplate) {
    const url = resolveTemplate(value.resource.dashTemplate, params);
    return { ...value, resource: { url, headers: value.resource.headers || {} } };
  }
  return value;
}
module.exports = { sealTicket, openTicket };
