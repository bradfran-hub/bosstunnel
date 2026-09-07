"use strict";
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");

async function main() {
  const dir = await fs.mkdtemp("/tmp/boss-customer-browser-");
  let runtime, browser;
  try {
    const reservation = http.createServer();
    await new Promise(resolve => reservation.listen(0, "0.0.0.0", resolve));
    const port = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    Object.assign(process.env, { DATA_DIR: dir, BASE_PATH: "/", BOSS_SECRET: "browser-customer-secret-at-least-32-characters", BOSS_ADMIN_TOKEN: "browser-admin-test-only-token", BOSS_CUSTOMER_ACCOUNTS: "true", PUBLIC_BASE_URL: base });
    runtime = require("../server"); await runtime.ready;
    const { capabilities } = require("../core/model");
    runtime.engine.registry.factories.set("boss", source => ({ id: source.id,
      capabilities: capabilities({ catalog: true, streams: true, types: ["movie"] }),
      catalogs: [{ key: "movies", type: "movie", enumerable: true }],
      async catalog() { return { items: [{ type: "movie", sourceKey: "fixture", title: "Owned fixture" }], nextCursor: null }; },
      async resolve() { return []; }
    }));
    await new Promise(resolve => runtime.server.listen(port, "0.0.0.0", resolve));
    browser = await chromium.launch({ executablePath: "/root/.cache/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-linux64/chrome-headless-shell", headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const password = "browser test account password", changedPassword = `${password} changed`, resetPassword = `${password} reset`;
    const authForm = page.locator("#customer-form");
    await fs.mkdir(path.resolve("artifacts"), { recursive: true });
    async function screenshots(stage) {
      for (const [name, width, height] of [["desktop", 1440, 1000], ["mobile", 390, 844], ["small-mobile", 320, 720]]) {
        await page.setViewportSize({ width, height });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${stage}: ${name} overflow`);
        assert.equal(await page.locator(".brand img").evaluate(img => img.complete && img.naturalWidth > 0), true);
        await page.screenshot({ path: path.resolve(`artifacts/customer-${stage}-${name}.png`), fullPage: true, mask: [page.locator(".install-url,.credentials")] });
      }
    }
    async function credentials(value = password) {
      await authForm.locator('[name="username"]').fill("browser-customer");
      await authForm.locator('[name="password"]').fill(value);
    }
    async function signedIn() {
      await page.waitForSelector("#customer-controls", { state: "visible" });
      await page.waitForSelector("#libraries-section", { state: "visible" });
      assert.equal(await page.locator("#admin-token-field").isVisible(), false);
      assert.equal(await page.locator("#identity-reviews").isVisible(), false);
      assert.equal(await page.locator("#admin-token-field input").isVisible(), false);
      assert.equal(await page.locator("#admin-token-field input").evaluate(input => input.required), false);
      assert.equal(await page.locator("#admin-token-field input").inputValue(), "");
    }
    await page.goto(`${base}/workspace`);
    await page.waitForSelector("#customer-entry", { state: "visible" });
    assert.equal(await page.locator("#workspace-content").isVisible(), false);
    assert.equal(await page.locator('input[type="email"]').count(), 0);
    await screenshots("login");
    await page.click("#sign-up-tab"); await credentials();
    await authForm.locator('[name="confirmPassword"]').fill(password);
    await page.click("#customer-submit");
    await page.waitForSelector("#customer-recovery-dialog[open]");
    const recoveryCode = await page.locator("#customer-recovery-code").textContent();
    assert.match(recoveryCode, /^boss-recovery-/);
    // Never put recovery secrets into diagnostic screenshots.
    await page.click("#close-recovery"); await signedIn();
    assert.equal(await page.locator("#customer-recovery-code").textContent(), "");
    assert.equal((await context.cookies()).filter(cookie => cookie.name.startsWith("boss_session_")).every(cookie => cookie.httpOnly && cookie.sameSite === "Strict"), true);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await page.locator('#addon-form [name="sourceType"][value="boss"]').check({ force: true });
    await page.locator('#addon-form [name="addonName"]').fill("Fixture source");
    await page.locator('#addon-form [name="baseUrl"]').fill("https://owned.example.invalid/addon.boss");
    await page.click('#addon-form button[type="submit"]');
    await page.waitForSelector("#addon-list .addon-card");
    await page.locator('#library-form [name="libraryName"]').fill("Merged fixture library");
    await page.locator('#library-sources input').first().check();
    await page.click('#library-form button[type="submit"]');
    await page.waitForSelector("#library-list .addon-card");
    const priorInstall = await page.locator("#library-list .install-url").textContent();
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#library-list [data-rotate-installation]").click();
    await page.waitForFunction(old => document.querySelector("#library-list .install-url")?.textContent !== old, priorInstall);
    assert.equal((await fetch(priorInstall)).status, 401);
    assert.equal((await fetch(await page.locator("#library-list .install-url").textContent())).status, 200);
    // Installation credentials belong to this temporary fixture; mask them in images.
    await screenshots("workspace");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click("#customer-settings");
    const settings = page.locator("#customer-password-form");
    await settings.locator('[name="currentPassword"]').fill(password);
    await settings.locator('[name="password"]').fill(changedPassword);
    await settings.locator('[name="confirmPassword"]').fill(changedPassword);
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector("#customer-recovery-dialog").open || document.querySelector("#customer-password-status").textContent);
    const passwordState = await page.evaluate(() => ({ open: document.querySelector("#customer-recovery-dialog").open, status: document.querySelector("#customer-password-status").textContent, account: window.BossAccount }));
    assert.equal(passwordState.open, true, JSON.stringify(passwordState));
    const rotated = await page.locator("#customer-recovery-code").textContent();
    assert.notEqual(rotated, recoveryCode);
    await page.click("#close-recovery");
    await page.waitForSelector("#customer-entry", { state: "visible" });
    assert.equal(await page.locator("#workspace-content").isVisible(), false);
    await page.click("#sign-in-tab"); await credentials(changedPassword); await page.click("#customer-submit"); await signedIn();
    await page.waitForFunction(() => document.querySelector("#library-list")?.textContent.includes("Installation links revoked"));
    assert.equal(await page.locator("#library-list .install-url").count(), 0);
    page.once("dialog", dialog => dialog.accept());
    await page.locator("#library-list [data-rotate-installation]").click();
    await page.waitForSelector("#library-list .install-url");
    assert.equal((await fetch(await page.locator("#library-list .install-url").textContent())).status, 200);
    await page.click("#customer-settings"); await page.click("#customer-lock");
    await page.waitForSelector("#customer-entry", { state: "visible" });
    assert.equal(await page.locator("#library-list .addon-card").count(), 0);
    await screenshots("vault-locked");
    await page.reload();
    await page.waitForSelector("#customer-entry", { state: "visible" });
    assert.equal(await page.locator("#workspace-content").isVisible(), false);
    await page.click("#sign-in-tab"); await credentials(changedPassword); await page.click("#customer-submit"); await signedIn();
    assert.equal(await page.locator("#library-list h3").textContent(), "Merged fixture library");
    await page.reload(); await signedIn();
    await page.click("#customer-settings"); await page.click("#customer-logout-all");
    await page.waitForSelector("#customer-entry", { state: "visible" });
    await page.click("#customer-recover"); await credentials(resetPassword);
    await authForm.locator('[name="confirmPassword"]').fill(resetPassword);
    await authForm.locator('[name="recoveryCode"]').fill(rotated);
    page.once("dialog", dialog => dialog.accept());
    await page.click("#customer-submit");
    await page.waitForSelector("#customer-recovery-dialog[open]");
    assert.notEqual(await page.locator("#customer-recovery-code").textContent(), rotated);
    await page.click("#close-recovery"); await signedIn();
    assert.equal(await page.locator("#addon-list .addon-card").count(), 0);
    assert.equal(await page.locator("#library-list .addon-card").count(), 0);
    await page.click("#lock-btn"); await page.waitForSelector("#customer-entry", { state: "visible" });
    await page.click("#sign-in-tab"); await credentials(changedPassword); await page.click("#customer-submit");
    await page.waitForFunction(() => document.querySelector("#customer-form-status").textContent.includes("Invalid username or password"));
    await credentials(resetPassword); await page.click("#customer-submit"); await signedIn();
    runtime.engine.graph.sql("DELETE FROM CustomerSessions").run();
    await page.click("#refresh-btn"); await page.waitForSelector("#customer-entry", { state: "visible" });
    assert.equal(await page.locator("#workspace-content").isVisible(), false);
    await page.goto(`${base}/admin`);
    await page.waitForSelector("#admin-token-field", { state: "visible" });
    assert.equal(await page.locator("#customer-entry").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log("Customer browser checks passed: signup, sessions, ownership, password rotation, destructive recovery, logout, expiry and responsive layouts.");
  } finally {
    if (browser) await browser.close();
    if (runtime) { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); await runtime.close(); }
    await fs.rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
