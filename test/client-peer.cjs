"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createClientPeer } = require("../core/client-peer");
const request = (socket, headers = {}) => ({ socket: { remoteAddress: socket }, headers });
test("client identity ignores untrusted forwarding and normalizes mapped addresses", () => {
  const direct = createClientPeer();
  assert.equal(direct(request("::ffff:127.0.0.1", { "x-boss-client-ip": "1.1.1.1", "cf-connecting-ip": "8.8.8.8" })), "127.0.0.1");
  const proxied = createClientPeer("127.0.0.1, ::1");
  assert.equal(proxied(request("127.0.0.2", { "x-boss-client-ip": "1.1.1.1" })), "127.0.0.2");
  assert.equal(proxied(request("::ffff:127.0.0.1", { "x-boss-client-ip": "::ffff:1.1.1.1" })), "1.1.1.1");
  assert.equal(proxied(request("::1", { "x-boss-client-ip": "2606:4700:4700:0:0:0:0:1111" })), "2606:4700:4700::1111");
  for (const value of ["1.1.1.1, 8.8.8.8", ["1.1.1.1"], "1.1.1.1:123", "1.1.1.1\n", "localhost", "0x7f000001", "fe80::1%eth0", undefined]) {
    assert.equal(proxied(request("127.0.0.1", { "x-boss-client-ip": value, "x-forwarded-for": "8.8.8.8", "x-real-ip": "8.8.8.8", "cf-connecting-ip": "8.8.8.8" })), "127.0.0.1");
  }
  assert.equal(proxied(request(undefined)), "unknown");
  for (const value of ["0.0.0.0/0", "127.0.0.0/8", "localhost", "127.0.0.1,", Array(33).fill("127.0.0.1").join(",")]) assert.throws(() => createClientPeer(value), /exact IP/);
});
