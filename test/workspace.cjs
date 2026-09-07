"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
test("older workspace API paths preserve POST validation and authentication", async () => {
  const directory = await fs.mkdtemp("/tmp/boss-workspace-test-");
  process.env.DATA_DIR = directory;
  process.env.BASE_PATH = "/";
  process.env.BOSS_ADMIN_TOKEN = "test-only-workspace-administration";
  process.env.BOSS_SECRET = "test-only-workspace-encryption-secret";
  const app = require("../server");
  try {
    await app.ready;
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    for (const path of ["/api/probe", "/workspace/api/probe", "/workspace/api/addons"]) {
      const rejected = await fetch(origin + path, { method: "POST", body: "{}" });
      assert.equal(rejected.status, 401); await rejected.body.cancel();
      const response = await fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN }, body: "{}" });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /supported source type/);
    }
    const response = await fetch(origin + "/workspace/healthz");
    assert.equal(response.status, 200); await response.body.cancel();
  } finally {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
