"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const ipaddr = require("ipaddr.js");
const { Agent, buildConnector } = require("undici");
const { httpMedia } = require("../stream-policy");
const context = new AsyncLocalStorage();
const denied = () => Object.assign(new Error("Customer sources require a public media endpoint"), { code: "SOURCE_NETWORK_DENIED", status: 403 });
const hostname = value => String(value).toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
const localAddresses = new Set(Object.values(os.networkInterfaces()).flat().filter(Boolean).map(value => ipaddr.process(value.address.split("%")[0]).toString()));
function publicAddress(value) {
  try {
    const parsed = ipaddr.process(value);
    return parsed.range() === "unicast" && !localAddresses.has(parsed.toString()) && parsed.toString() !== "168.63.129.16";
  } catch { return false; }
}
function assertHost(value) {
  const host = hostname(value);
  let ownHost;
  try { ownHost = hostname(new URL(process.env.PUBLIC_BASE_URL).hostname); } catch {}
  if (!host || host === ownHost || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw denied();
  if (ipaddr.isValid(host)) { if (!publicAddress(host)) throw denied(); }
  else if (!host.includes(".") || host.length > 253) throw denied();
  return host;
}
function assertUrl(value) {
  const input = value instanceof Request ? value.url : String(value);
  if (!httpMedia(input)) throw denied();
  const url = new URL(input); assertHost(url.hostname); return url;
}
function createLookup(resolve = dns.lookup) {
  return (name, options, callback) => {
    if (typeof options === "function") { callback = options; options = {}; }
    if (typeof options === "number") options = { family: options };
    let host;
    try { host = assertHost(name); } catch (error) { callback(error); return; }
    // Return the validated addresses to the socket itself, not a second DNS lookup.
    resolve(host, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return callback(error);
      if (!Array.isArray(addresses) || !addresses.length || addresses.some(row => !publicAddress(row.address))) return callback(denied());
      const selected = options.family ? addresses.filter(row => row.family === options.family) : addresses;
      if (!selected.length) return callback(denied());
      if (options.all) callback(null, selected);
      else callback(null, selected[0].address, selected[0].family);
    });
  };
}
const lookup = createLookup();
const connector = buildConnector({ lookup, timeout: 10000 });
const dispatcher = new Agent({ connections: 4, keepAliveTimeout: 1000, keepAliveMaxTimeout: 5000, connect(options, callback) {
  try { assertHost(options.hostname); return connector(options, callback); }
  catch (error) { queueMicrotask(() => callback(error)); }
} });
class PublicHttpAgent extends http.Agent {
  createConnection(options, callback) {
    try { assertHost(options.hostname || options.host); return super.createConnection({ ...options, lookup }, callback); }
    catch (error) { queueMicrotask(() => callback(error)); }
  }
}
class PublicHttpsAgent extends https.Agent {
  createConnection(options, callback) {
    try { assertHost(options.hostname || options.host); return super.createConnection({ ...options, lookup }, callback); }
    catch (error) { queueMicrotask(() => callback(error)); }
  }
}
const httpAgent = new PublicHttpAgent({ keepAlive: false, maxSockets: 16, maxTotalSockets: 32 });
const httpsAgent = new PublicHttpsAgent({ keepAlive: false, maxSockets: 16, maxTotalSockets: 32 });
function networkFetch(url, options = {}) {
  const scope = context.getStore();
  scope?.access?.assertCurrent();
  if (scope?.publicOnly) assertUrl(url);
  const signals = [options.signal, url instanceof Request ? url.signal : null, scope?.access?.signal].filter(Boolean);
  return fetch(url, { ...options, ...(scope?.publicOnly ? { dispatcher } : {}), ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
}
function requestSignal(...signals) {
  const scope = context.getStore(); scope?.access?.assertCurrent();
  return AbortSignal.any([...signals, scope?.access?.signal].filter(Boolean));
}
function axiosOptions() {
  const scope = context.getStore(); scope?.access?.assertCurrent();
  return { ...(scope?.publicOnly ? { httpAgent, httpsAgent, proxy: false, adapter: "http" } : {}), ...(scope?.access ? { signal: scope.access.signal } : {}) };
}
function scoped(publicOnly, task, access = null) { access?.assertCurrent(); return context.run({ publicOnly: Boolean(publicOnly), access }, task); }
function wrapAdapter(adapter, publicOnly, access = null) {
  if (!publicOnly && !access) return adapter;
  const wrapped = { ...adapter };
  const guarded = result => {
    if (!access) return result;
    if (result?.then) return require("./abortable").abortable(result, access.signal).then(value => { access.assertCurrent(); return value; });
    access.assertCurrent(); return result;
  };
  for (const [name, method] of Object.entries(adapter)) if (typeof method === "function") wrapped[name] = (...args) => scoped(publicOnly, () => {
    const result = method.apply(adapter, args);
    if (!result?.[Symbol.asyncIterator]) return guarded(result);
    const iterator = result[Symbol.asyncIterator]();
    return { [Symbol.asyncIterator]() { return this; }, next: value => scoped(publicOnly, () => guarded(iterator.next(value)), access),
      return: value => context.run({ publicOnly, access }, () => iterator.return ? iterator.return(value) : Promise.resolve({ done: true, value })),
      throw: error => scoped(publicOnly, () => guarded(iterator.throw ? iterator.throw(error) : Promise.reject(error)), access) };
  }, access);
  return wrapped;
}
module.exports = { networkFetch, axiosOptions, requestSignal, scoped, wrapAdapter, assertUrl, publicAddress, createLookup };
