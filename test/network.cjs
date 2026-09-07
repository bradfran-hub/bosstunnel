"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const axios = require("axios");
const { scoped, networkFetch, axiosOptions, assertUrl, publicAddress, createLookup, wrapAdapter } = require("../core/network");
test("customer egress blocks special IP ranges, local aliases and the configured Boss hostname", () => {
  for (const address of ["127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.1.2", "192.168.1.2", "169.254.169.254", "100.100.100.200", "224.0.0.1", "255.255.255.255", "168.63.129.16", "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "2001:db8::1"]) assert.equal(publicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true);
  const before = process.env.PUBLIC_BASE_URL; process.env.PUBLIC_BASE_URL = "https://boss.example.com/bossmedia";
  try {
    for (const url of ["http://localhost/", "http://local.localhost/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "http://metadata.google.internal/", "http://router/", "https://BOSS.EXAMPLE.COM./", "file:///etc/passwd", "http://user:password@public.example/"]) assert.throws(() => assertUrl(url), { code: "SOURCE_NETWORK_DENIED" });
    assert.equal(assertUrl("https://media.example.com/library").hostname, "media.example.com");
  } finally { if (before === undefined) delete process.env.PUBLIC_BASE_URL; else process.env.PUBLIC_BASE_URL = before; }
});
test("socket DNS lookup returns only validated addresses and rejects mixed public/private answers", async () => {
  const check = (addresses, options = { all: true }) => new Promise((resolve, reject) => createLookup((name, query, callback) => callback(null, addresses))("media.example.com", options, (error, ...result) => error ? reject(error) : resolve(result)));
  const publicRows = [{ address: "1.1.1.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }];
  assert.deepEqual(await check(publicRows), [publicRows]);
  assert.deepEqual(await check(publicRows, { family: 4 }), ["1.1.1.1", 4]);
  await assert.rejects(check([...publicRows, { address: "127.0.0.1", family: 4 }]), { code: "SOURCE_NETWORK_DENIED" });
  await assert.rejects(check([{ address: "::ffff:10.0.0.1", family: 6 }]), { code: "SOURCE_NETWORK_DENIED" });
  await assert.rejects(check([]), { code: "SOURCE_NETWORK_DENIED" });
});
test("fetch, SDK HTTP agents and deferred adapter iteration retain the customer network policy", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => { requests++; res.end("authorized admin fixture"); });
  try {
    await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    assert.throws(() => scoped(true, () => networkFetch(url)), { code: "SOURCE_NETWORK_DENIED" });
    const client = scoped(true, () => axios.create({ ...axiosOptions(), timeout: 1000 }));
    await assert.rejects(client.get(url), error => error.code === "SOURCE_NETWORK_DENIED");
    const adapter = wrapAdapter({ async *scanCatalog() { await Promise.resolve(); yield await networkFetch(url); }, async resolve() { await Promise.resolve(); return networkFetch(url); } }, true);
    await assert.rejects(adapter.scanCatalog().next(), { code: "SOURCE_NETWORK_DENIED" });
    await assert.rejects(adapter.resolve(), { code: "SOURCE_NETWORK_DENIED" });
    assert.equal(requests, 0);
    assert.equal(await (await scoped(false, () => networkFetch(url))).text(), "authorized admin fixture");
    assert.equal(requests, 1);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
