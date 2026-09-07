"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");
const { createClientPeer } = require("../core/client-peer");
const { AuthLimit } = require("../core/auth-limit");
async function main() {
  const dir = await fs.mkdtemp("/tmp/boss-edge-test-"), peer = createClientPeer("127.0.0.1"), limit = new AuthLimit({ failures: 2 });
  const app = http.createServer((req, res) => {
    const client = peer(req), retry = limit.check(client);
    if (!retry) limit.failed(client);
    res.writeHead(retry ? 429 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ client }));
  });
  let nginx, stopped;
  try {
    await new Promise(resolve => app.listen(0, "0.0.0.0", resolve));
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const snippet = (await fs.readFile(path.resolve("ops/customer-release/bossmedia-tunnel-location.conf"), "utf8"))
      .replace("http://127.0.0.1:3098", `http://127.0.0.1:${app.address().port}`)
      .replace("/var/log/nginx/bossmedia-diagnostics.log", "/dev/null");
    const config = `daemon off; master_process off; pid ${dir}/nginx.pid; error_log /dev/null crit;
events { worker_connections 32; }
http { access_log off; log_format boss_diagnostics '$status';
client_body_temp_path ${dir}/body; proxy_temp_path ${dir}/proxy;
fastcgi_temp_path ${dir}/fastcgi; uwsgi_temp_path ${dir}/uwsgi; scgi_temp_path ${dir}/scgi;
server { listen 127.0.0.1:${port}; server_name sainttv.win; ${snippet} } }
`;
    const filename = path.join(dir, "nginx.conf"); await fs.writeFile(filename, config, { mode: 0o600 });
    nginx = spawn("/usr/sbin/nginx", ["-p", `${dir}/`, "-c", filename], { stdio: "ignore" });
    stopped = new Promise((resolve, reject) => { nginx.once("error", reject); nginx.once("exit", resolve); });
    const base = `http://127.0.0.1:${port}/bossmedia`;
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const response = await fetch(base, { redirect: "manual" }); await response.body.cancel(); if (response.status === 302) { ready = true; break; } } catch {}
      if (nginx.exitCode !== null) break;
      await sleep(50);
    }
    assert.equal(ready, true, "Isolated NGINX must start with the candidate snippet");
    const headers = { "CF-Connecting-IP": "203.0.113.41", "X-Boss-Client-IP": "203.0.113.99", "X-Forwarded-For": "203.0.113.99", "X-Real-IP": "203.0.113.99" };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/account/me`, { headers });
      assert.equal(response.status, 200); assert.equal((await response.json()).client, "203.0.113.41");
    }
    const throttled = await fetch(`${base}/account/me`, { headers }); assert.equal(throttled.status, 429); await throttled.body.cancel();
    const separate = await fetch(`${base}/account/me`, { headers: { ...headers, "CF-Connecting-IP": "203.0.113.42" } });
    assert.equal(separate.status, 200); assert.equal((await separate.json()).client, "203.0.113.42");
    const forged = await fetch(`${base}/account/me`, { headers: { "X-Boss-Client-IP": "203.0.113.99", "X-Forwarded-For": "203.0.113.99" } });
    assert.equal((await forged.json()).client, "127.0.0.1");
    const malformed = await fetch(`${base}/account/me`, { headers: { ...headers, "CF-Connecting-IP": "not-an-address" } });
    assert.equal((await malformed.json()).client, "127.0.0.1");
    console.log("Isolated NGINX checks passed: candidate config, two client limits, forwarding overwrite and malformed-header fallback. Public Cloudflare ingress is not certified by this fixture.");
  } finally {
    if (nginx && nginx.exitCode === null) nginx.kill("SIGQUIT");
    if (stopped) await stopped;
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
