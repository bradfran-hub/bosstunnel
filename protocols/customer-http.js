"use strict";
const { CustomerAuth } = require("../core/customer-auth");
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function createCustomerHttp({ graph, baseUrl, basePath, body, json, peer = req => req.socket.remoteAddress || "unknown", onDelete = () => {} }) {
  const auth = new CustomerAuth(graph), origin = new URL(baseUrl).origin, secure = new URL(baseUrl).protocol === "https:";
  const cookieName = `boss_session_${require("node:crypto").createHash("sha256").update(basePath).digest("hex").slice(0, 8)}`;
  function token(req) {
    const cookies = String(req.headers.cookie || "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    if (cookies.length > 1) throw fail("Ambiguous session cookie", 401);
    return cookies[0]?.slice(cookieName.length + 1);
  }
  function checkOrigin(req) {
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) throw fail("Cross-origin account requests are not allowed", 403);
  }
  function session(req, mutation = false, requireUnlocked = true) {
    const value = token(req);
    if (mutation) checkOrigin(req);
    const result = mutation ? auth.csrf(value, req.headers["x-boss-csrf"]) : auth.verify(value);
    if (requireUnlocked) auth.vaultAccess(result.customer.id);
    return result;
  }
  function setCookie(res, value = "", expiresAt = 0) {
    const seconds = value ? Math.max(0, Math.floor((expiresAt - graph.clock()) / 1000)) : 0;
    const cookiePath = basePath === "/" ? "/" : `${basePath}/`;
    res.setHeader("Set-Cookie", `${cookieName}=${value}; Path=${cookiePath}; HttpOnly; SameSite=Strict; Max-Age=${seconds}${secure ? "; Secure" : ""}`);
  }
  function response(req, res, result, status = 200) {
    const previous = token(req);
    if (previous) {
      let sameCustomer = false;
      try { sameCustomer = auth.verify(previous).customer.id === result.customer.id; } catch {}
      auth.revoke(previous, { lock: !sameCustomer });
    }
    setCookie(res, result.token, result.expiresAt);
    const { token: ignored, ...publicResult } = result;
    return json(res, status, publicResult);
  }
  async function handle(req, res, path) {
    if (path === "/me" && req.method === "GET") return json(res, 200, session(req, false, false));
    if (req.method !== "POST") throw fail("Method not allowed", 405);
    checkOrigin(req);
    if (!["/register", "/login", "/recover", "/password", "/lock", "/logout", "/logout-all", "/delete"].includes(path)) throw fail("Account operation not found", 404);
    if (!["/register", "/login", "/recover"].includes(path)) session(req, true, false);
    if (path === "/lock") {
      auth.lockVault(session(req, false, false).customer.id);
      return json(res, 200, session(req, false, false));
    }
    if (path === "/logout" || path === "/logout-all") {
      if (path === "/logout-all") auth.revokeAll(token(req)); else auth.revoke(token(req));
      setCookie(res); return json(res, 200, { ok: true });
    }
    if ((req.headers["content-type"] || "").split(";", 1)[0].toLowerCase().trim() !== "application/json") throw fail("Account requests require application/json", 415);
    // Validate duplicate cookies before creating a replacement session.
    token(req);
    const input = await body(req);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw fail("Invalid account request");
    const allowed = { "/register": ["username", "password"], "/login": ["username", "password"], "/recover": ["username", "password", "recoveryCode"], "/password": ["currentPassword", "password"], "/delete": ["password", "confirmation"] }[path];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw fail("Unsupported account field");
    if (path === "/delete") {
      const result = await auth.deleteAccount(token(req), input, peer(req));
      onDelete(result.sourceIds); setCookie(res);
      return json(res, 200, { ok: true });
    }
    const result = path === "/password" ? await auth.changePassword(token(req), input, peer(req)) : await auth[{ "/register": "register", "/login": "login", "/recover": "recover" }[path]](input, peer(req));
    if (result.removedSourceIds) { onDelete(result.removedSourceIds); delete result.removedSourceIds; }
    return response(req, res, result, path === "/register" ? 201 : 200);
  }
  return { auth, handle, session, token, checkOrigin, close: () => auth.close() };
}
module.exports = { createCustomerHttp };
