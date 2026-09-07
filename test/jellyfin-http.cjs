"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const { authorization } = require("../protocols/jellyfin-http");

test("Jellyfin authorization rejects malformed and ambiguous credentials", () => {
  const parse = (headers, query = "", rawHeaders = []) => authorization({ headers, rawHeaders }, new URL(`http://test/${query}`));
  assert.deepEqual(parse({ authorization: 'MediaBrowser DeviceId="player", Client="A, B", Token="token"' }), { deviceId: "player", token: "token" });
  assert.equal(parse({ "x-emby-authorization": 'MediaBrowser DeviceId="player"', "x-emby-token": "token" }).token, "token");
  assert.equal(parse({}, "?api_key=token").token, "token");
  for (const value of ['Basic secret', 'MediaBrowser Token="one",Token="two"', 'MediaBrowser Token="one",', 'MediaBrowser Token=one', 'MediaBrowser Token="one" garbage', 'MediaBrowser DeviceId="bad\nvalue"']) assert.throws(() => parse({ authorization: value }), { status: 401 });
  assert.throws(() => parse({ authorization: 'MediaBrowser Token="one"', "x-emby-token": "two" }), { status: 401 });
  assert.throws(() => parse({}, "?api_key=one&api_key=two"), { status: 401 });
  assert.throws(() => parse({ authorization: 'MediaBrowser Token="one"' }, "", ["Authorization", "one", "Authorization", "two"]), { status: 401 });
});

test("experimental Jellyfin HTTP authenticates the official SDK and scopes catalogue access", async () => {
  const dir = await fs.mkdtemp("/tmp/boss-jellyfin-http-");
  let runtime, artworkServer, releaseSlow;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCuoAAAAASUVORK5CYII=", "base64");
  let artworkRequests = 0;
  try {
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}/bossmedia`;
    Object.assign(process.env, { DATA_DIR: dir, BOSS_ADMIN_TOKEN: "jellyfin-test-admin-token", BOSS_SECRET: "jellyfin-http-test-secret-at-least-32-characters", PUBLIC_BASE_URL: base, BOSS_JELLYFIN_OUTPUT: "true" });
    runtime = require("../server"); await runtime.ready;
    await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    const graph = runtime.engine.graph;
    artworkServer = http.createServer((req, res) => {
      artworkRequests++;
      if (req.headers.authorization !== "Bearer upstream-artwork") { res.writeHead(401); return res.end(); }
      const pathname = new URL(req.url, "http://fixture").pathname;
      if (pathname === "/not-image") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<html>Not artwork</html>"); }
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": pathname === "/large" ? 9 * 1024 * 1024 : png.length });
      if (req.method === "HEAD") return res.end();
      if (pathname === "/slow") { res.write(png.subarray(0, 8)); releaseSlow = () => res.end(png.subarray(8)); return; }
      res.end(png);
    });
    await new Promise(resolve => artworkServer.listen(0, "0.0.0.0", resolve));
    const artwork = suffix => ({ url: `http://127.0.0.1:${artworkServer.address().port}/${suffix}`, headers: { Authorization: "Bearer upstream-artwork" } });
    graph.addSource({ id: "one", protocol: "fixture", name: "Owned", configuration: { password: "never-expose" } });
    graph.addSource({ id: "other", protocol: "fixture", name: "Other", configuration: {} });
    graph.ingest("one", [{ type: "movie", sourceKey: "owned", title: "Owned movie", artwork: { poster: artwork("poster"), backdrop: artwork("backdrop") } }]);
    graph.ingest("one", [{ type: "series", sourceKey: "show", title: "Owned series" }, { type: "channel", sourceKey: "live", title: "Owned channel", channel: { number: "1" } }]);
    graph.ingest("other", [{ type: "movie", sourceKey: "excluded", title: "Excluded movie" }]);
    const collection = graph.createCollection({ name: "Customer", sourceIds: ["one"] });
    const accountUrl = `${base}/api/libraries/${collection.id}/outputs/jellyfin`;
    assert.equal((await fetch(accountUrl, { method: "POST" })).status, 401);
    const provisioned = await fetch(accountUrl, { method: "POST", headers: { "X-Boss-Admin": process.env.BOSS_ADMIN_TOKEN } });
    assert.equal(provisioned.status, 201);
    const credentials = await provisioned.json();
    assert.equal(credentials.playback, false);
    assert.equal(provisioned.headers.get("cache-control"), "private, no-store");
    const { Jellyfin } = await import("@jellyfin/sdk");
    const { getUserApi } = await import("@jellyfin/sdk/lib/utils/api/user-api.js");
    const { getItemsApi } = await import("@jellyfin/sdk/lib/utils/api/items-api.js");
    const { getSessionApi } = await import("@jellyfin/sdk/lib/utils/api/session-api.js");
    const { getSystemApi } = await import("@jellyfin/sdk/lib/utils/api/system-api.js");
    const { getUserViewsApi } = await import("@jellyfin/sdk/lib/utils/api/user-views-api.js");
    const { getImageApi } = await import("@jellyfin/sdk/lib/utils/api/image-api.js");
    const sdk = new Jellyfin({ clientInfo: { name: "Boss Test", version: "1" }, deviceInfo: { name: "Test player", id: "test-player" } });
    assert.equal(credentials.server, `${base}/jellyfin`);
    const anonymous = sdk.createApi(credentials.server);
    const discovery = (await getSystemApi(anonymous).getPublicSystemInfo()).data;
    assert.equal(discovery.ProductName, "Boss Media Servers");
    assert.equal(discovery.Version, require("../package.json").version);
    assert.equal(discovery.LocalAddress, credentials.server);
    assert.deepEqual(await (await fetch(`${base}/jellyfin/Users/Public`)).json(), []);
    assert.ok(!JSON.stringify(discovery).includes("Customer") && !JSON.stringify(discovery).includes(credentials.username));
    const login = () => getUserApi(anonymous).authenticateUserByName({ authenticateUserByName: { Username: credentials.username, Pw: credentials.password } });
    const session = (await login()).data;
    assert.equal(session.User.Id, credentials.userId);
    assert.equal(session.User.Policy.IsAdministrator, false);
    assert.equal(session.User.Policy.EnableMediaPlayback, false);
    assert.equal(session.ServerId, discovery.Id);
    const logged = sdk.createApi(`${base}/jellyfin`, session.AccessToken);
    const items = (await getItemsApi(logged).getItems({ includeItemTypes: ["Movie"], userId: session.User.Id })).data;
    assert.equal(items.TotalRecordCount, 1);
    assert.equal(items.Items[0].Name, "Owned movie");
    assert.ok(!JSON.stringify(items).includes("never-expose"));
    assert.match(items.Items[0].ImageTags.Primary, /^[a-f0-9]{32}$/);
    assert.equal(items.Items[0].BackdropImageTags.length, 1);
    assert.ok(!JSON.stringify(items).includes("upstream-artwork") && !JSON.stringify(items).includes("/poster"));
    const imageUrl = `${base}/jellyfin/Items/${items.Items[0].Id}/Images/Primary`;
    const beforeUnauthorized = artworkRequests;
    assert.equal((await fetch(imageUrl)).status, 401);
    assert.equal(artworkRequests, beforeUnauthorized);
    await assert.rejects(getImageApi(logged).getItemImage({ itemId: items.Items[0].Id, imageType: "Primary", tag: items.Items[0].ImageTags.Primary, maxWidth: 200 }, { responseType: "arraybuffer" }), error => error.response?.status === 401);
    const image = await fetch(imageUrl, { redirect: "manual", headers: { "X-Emby-Token": session.AccessToken } });
    assert.equal(image.status, 307);
    assert.equal(image.headers.get("location"), `http://127.0.0.1:${artworkServer.address().port}/poster`);
    assert.equal((await image.arrayBuffer()).byteLength, 0);
    assert.deepEqual(Buffer.from(await (await fetch(image.headers.get("location"), { headers: { Authorization: "Bearer upstream-artwork" } })).arrayBuffer()), png);
    assert.equal((await fetch(imageUrl, { method: "HEAD", redirect: "manual", headers: { "X-Emby-Token": session.AccessToken } })).status, 307);
    const backdrop = await fetch(`${base}/jellyfin/Items/${items.Items[0].Id}/Images/Backdrop/0`, { redirect: "manual", headers: { "X-Emby-Token": session.AccessToken } });
    assert.equal(backdrop.status, 307); assert.match(backdrop.headers.get("location"), /\/backdrop$/);
    await assert.rejects(getImageApi(logged).getItemImageByIndex({ itemId: items.Items[0].Id, imageType: "Backdrop", imageIndex: 1 }), error => error.response?.status === 404);
    const replacePoster = suffix => graph.ingest("one", [{ type: "movie", sourceKey: "owned", title: "Owned movie", artwork: { poster: artwork(suffix) } }]);
    replacePoster("poster?v=2");
    assert.notEqual((await getItemsApi(logged).getItems({ includeItemTypes: ["Movie"] })).data.Items[0].ImageTags.Primary, items.Items[0].ImageTags.Primary);
    for (const suffix of ["not-image", "large"]) {
      replacePoster(suffix);
      const direct = await fetch(imageUrl, { redirect: "manual", headers: { "X-Emby-Token": session.AccessToken } });
      assert.equal(direct.status, 307);
      assert.equal(new URL(direct.headers.get("location")).pathname, `/${suffix}`);
    }
    replacePoster("poster");
    const views = (await getUserViewsApi(logged).getUserViews({ userId: session.User.Id })).data;
    assert.equal(views.TotalRecordCount, 3);
    assert.deepEqual(views.Items.map(item => item.CollectionType), ["movies", "tvshows", "livetv"]);
    for (const view of views.Items) {
      assert.equal(view.Type, "CollectionFolder");
      assert.equal(view.ChildCount, 1);
      const contents = (await getItemsApi(logged).getItems({ parentId: view.Id })).data;
      assert.equal(contents.TotalRecordCount, 1);
      assert.equal(contents.Items[0].Type, { movies: "Movie", tvshows: "Series", livetv: "TvChannel" }[view.CollectionType]);
      assert.equal((await fetch(`${base}/jellyfin/Items/${view.Id}`, { headers: { "X-Emby-Token": session.AccessToken } })).status, 200);
    }
    assert.equal((await getItemsApi(logged).getItems({ parentId: views.Items[0].Id, includeItemTypes: ["TvChannel"] })).data.TotalRecordCount, 0);
    assert.deepEqual((await getUserViewsApi(logged).getUserViews()).data.Items.map(item => item.Id), views.Items.map(item => item.Id));
    await assert.rejects(getUserViewsApi(logged).getUserViews({ userId: "0".repeat(32) }), error => error.response?.status === 403);
    const { OutputLibrary } = require("../protocols/library");
    const { createJellyfinOutput } = require("../protocols/jellyfin");
    const otherCollection = graph.createCollection({ name: "Other customer", sourceIds: ["other"] });
    const otherViews = (await createJellyfinOutput(new OutputLibrary(runtime.engine, otherCollection, {}))).views();
    assert.equal(otherViews.TotalRecordCount, 1, "Empty views are omitted");
    assert.notEqual(otherViews.Items[0].Id, views.Items[0].Id);
    await assert.rejects(getItemsApi(logged).getItems({ parentId: otherViews.Items[0].Id }), error => error.response?.status === 404);
    await assert.rejects(getItemsApi(logged).getItems({ userId: "0".repeat(32) }), error => error.response?.status === 403);
    await assert.rejects(getItemsApi(logged).getItems({ sortBy: ["Random"] }), error => error.response?.status === 422);
    assert.equal((await fetch(`${base}/jellyfin/Items`)).status, 401);
    assert.equal((await fetch(`${base}/jellyfin/Items?api_key=${session.AccessToken}`)).status, 200);
    assert.equal((await fetch(`${base}/jellyfin/Items?api_key=other`, { headers: { "X-Emby-Token": session.AccessToken } })).status, 401);
    replacePoster("slow");
    const slowHandoff = await fetch(imageUrl, { redirect: "manual", headers: { "X-Emby-Token": session.AccessToken } });
    assert.equal(slowHandoff.status, 307);
    const slowImage = await fetch(slowHandoff.headers.get("location"), { headers: { Authorization: "Bearer upstream-artwork" } });
    const completed = slowImage.arrayBuffer();
    await getSessionApi(logged).reportSessionEnded();
    releaseSlow();
    assert.deepEqual(Buffer.from(await completed), png, "Logout cannot interrupt a provider request after direct handoff");
    replacePoster("poster");
    const afterLogout = artworkRequests;
    assert.equal((await fetch(imageUrl, { headers: { "X-Emby-Token": session.AccessToken } })).status, 401);
    assert.equal(artworkRequests, afterLogout);
    await assert.rejects(getItemsApi(logged).getItems(), error => error.response?.status === 401);
    const renewed = (await login()).data;
    graph.updateCollection(collection.id, { name: "Changed", revision: collection.revision, sourceIds: ["one", "other"] });
    assert.equal((await fetch(`${base}/jellyfin/Items`, { headers: { "X-Emby-Token": renewed.AccessToken } })).status, 401);
    const preflight = await fetch(`${base}/jellyfin/Items`, { method: "OPTIONS" });
    assert.ok(preflight.headers.get("access-control-allow-headers").includes("Authorization"));
    for (let i = 0; i < 30; i++) await assert.rejects(getUserApi(anonymous).authenticateUserByName({ authenticateUserByName: { Username: credentials.username, Pw: "wrong" } }), error => error.response?.status === 401);
    await assert.rejects(login(), error => error.response?.status === 429 && Number(error.response.headers["retry-after"]) > 0);
    process.env.BOSS_JELLYFIN_OUTPUT = "false";
    assert.equal((await fetch(`${base}/jellyfin/Items`)).status, 404);
  } finally {
    if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); }
    releaseSlow?.();
    if (artworkServer) { artworkServer.closeAllConnections(); await new Promise(resolve => artworkServer.close(resolve)); }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
