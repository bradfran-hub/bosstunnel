"use strict";
(() => {
  const base = location.pathname.replace(/\/(?:admin|workspace)\/?$/, "").replace(/\/$/, "");
  const entry = document.querySelector("#customer-entry"), form = document.querySelector("#customer-form");
  const recovery = document.querySelector("#customer-recovery-dialog"), settings = document.querySelector("#customer-settings-dialog");
  const account = window.BossAccount = { mode: "loading", customer: null, csrfToken: "", vault: null };
  let mode = "login", busy = false;
  const icons = () => window.lucide?.createIcons();
  const status = (id, message) => { const node = document.querySelector(id); node.textContent = message; node.hidden = !message; };
  function paint() {
    const customerMode = account.mode === "customer";
    const unlocked = Boolean(account.customer && account.vault?.unlocked);
    entry.hidden = !customerMode || unlocked;
    document.querySelector("#workspace-content").hidden = customerMode && !unlocked || account.mode === "loading";
    document.querySelector("#admin-token-field").hidden = customerMode;
    const token = document.querySelector("#addon-form").elements.adminToken;
    token.required = !customerMode;
    if (customerMode) token.value = "";
    document.querySelector("#identity-reviews").hidden = customerMode;
    document.querySelector("#customer-controls").hidden = !account.customer;
    const name = document.querySelector("#customer-name"); name.textContent = account.customer?.username || ""; name.title = name.textContent;
    const lock = document.querySelector("#lock-btn");
    lock.hidden = customerMode && !account.customer;
    lock.title = lock.ariaLabel = customerMode ? "Sign out" : "Lock workspace";
    lock.innerHTML = `<i data-lucide="${customerMode ? "log-out" : "lock-keyhole"}"></i>`;
    document.body.dataset.account = account.mode;
    icons();
  }
  account.headers = () => ({ "Content-Type": "application/json", "X-Boss-CSRF": account.csrfToken, "X-Boss-Customer": account.customer?.id || "" });
  account.clear = () => {
    account.customer = null; account.csrfToken = ""; account.vault = null; form.reset(); settings.close(); recovery.close(); paint();
    window.dispatchEvent(new Event("boss-account-change"));
  };
  function apply(result) {
    const knownUsername = account.customer?.username || "";
    account.customer = { ...result.customer, username: result.customer?.username || knownUsername || null }; account.csrfToken = result.csrfToken; account.vault = result.vault; account.mode = "customer"; form.reset();
    if (!account.vault?.unlocked) {
      switchMode("login");
      form.elements.username.value = account.customer.username;
      status("#customer-form-status", "Vault locked. Enter your password to unlock.");
    }
    paint();
    window.dispatchEvent(new Event("boss-account-change"));
    if (result.recoveryCode) {
      document.querySelector("#customer-recovery-code").textContent = result.recoveryCode;
      document.querySelector("#customer-recovery-user").textContent = result.customer.username;
      status("#recovery-status", ""); recovery.showModal();
    }
  }
  async function request(path, input) {
    const response = await fetch(`${base}/account/${path}`, { method: "POST", credentials: "same-origin", headers: account.headers(), body: JSON.stringify(input || {}) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "Account request failed"), { status: response.status });
    return result;
  }
  function switchMode(value) {
    if (busy) return;
    mode = value; form.reset(); status("#customer-form-status", "");
    const registering = mode === "register", recovering = mode === "recover";
    document.querySelector("#customer-entry-title").textContent = registering ? "Create account" : recovering ? "Recover account" : "Sign in";
    document.querySelector("#customer-password-label").textContent = recovering ? "New password" : "Password";
    document.querySelector("#customer-confirm-field").hidden = !registering && !recovering;
    form.elements.confirmPassword.disabled = !registering && !recovering;
    form.elements.confirmPassword.required = registering || recovering;
    document.querySelector("#customer-recovery-field").hidden = !recovering;
    form.elements.recoveryCode.disabled = !recovering; form.elements.recoveryCode.required = recovering;
    form.elements.password.autocomplete = registering || recovering ? "new-password" : "current-password";
    form.elements.password.minLength = registering || recovering ? 8 : 1;
    document.querySelector("#customer-submit span").textContent = registering ? "Create account" : recovering ? "Reset to empty account" : "Sign in";
    document.querySelector("#customer-recover").hidden = recovering;
    for (const tab of document.querySelectorAll("[data-account-mode]")) tab.setAttribute("aria-selected", String(tab.dataset.accountMode === mode));
  }
  for (const tab of document.querySelectorAll("[data-account-mode]")) tab.addEventListener("click", () => switchMode(tab.dataset.accountMode));
  document.querySelector("#customer-recover").addEventListener("click", () => switchMode("recover"));
  form.addEventListener("submit", async event => {
    event.preventDefault(); if (busy) return;
    if (mode !== "login" && form.elements.password.value !== form.elements.confirmPassword.value) return status("#customer-form-status", "Passwords do not match");
    const input = { username: form.elements.username.value.trim(), password: form.elements.password.value, ...(mode === "recover" ? { recoveryCode: form.elements.recoveryCode.value.trim() } : {}) };
    busy = true; document.querySelector("#customer-submit").disabled = true; status("#customer-form-status", "");
    try {
      if (mode === "recover" && !confirm("Recovery permanently removes every existing source and library because they cannot be decrypted without the old password. Continue?")) return;
      apply(await request(mode, input));
    }
    catch (error) { status("#customer-form-status", error.message); }
    finally { busy = false; document.querySelector("#customer-submit").disabled = false; form.elements.password.value = ""; form.elements.confirmPassword.value = ""; form.elements.recoveryCode.value = ""; }
  });
  account.logout = async (all = false) => {
    try { await request(all ? "logout-all" : "logout"); account.clear(); }
    catch (error) { if (error.status === 401) account.clear(); else { status("#customer-password-status", error.message); throw error; } }
  };
  account.locked = () => {
    account.vault = { unlocked: false, expiresAt: null }; settings.close(); recovery.close(); form.reset(); paint();
    status("#customer-form-status", "Vault locked. Enter your password to unlock.");
    window.dispatchEvent(new Event("boss-account-change"));
  };
  document.querySelector("#customer-lock").addEventListener("click", async () => {
    try { const result = await request("lock"); settings.close(); apply(result); }
    catch (error) { status("#customer-password-status", error.message); }
  });
  document.querySelector("#customer-settings").addEventListener("click", () => { document.querySelector("#customer-password-form").reset(); status("#customer-password-status", ""); settings.showModal(); });
  document.querySelector("#close-customer-settings").addEventListener("click", () => settings.close());
  settings.addEventListener("close", () => document.querySelector("#customer-password-form").reset());
  document.querySelector("#customer-password-form").addEventListener("submit", async event => {
    event.preventDefault(); const fields = event.currentTarget.elements, button = event.currentTarget.querySelector("button[type=submit]");
    if (fields.password.value !== fields.confirmPassword.value) return status("#customer-password-status", "Passwords do not match");
    button.disabled = true; status("#customer-password-status", "");
    try { const result = await request("password", { currentPassword: fields.currentPassword.value, password: fields.password.value }); settings.close(); apply(result); }
    catch (error) { status("#customer-password-status", error.message); }
    finally { button.disabled = false; fields.currentPassword.value = ""; fields.password.value = ""; fields.confirmPassword.value = ""; }
  });
  document.querySelector("#customer-logout-all").addEventListener("click", () => account.logout(true).catch(() => {}));
  document.querySelector("#customer-delete-form").addEventListener("submit", async event => {
    event.preventDefault();
    const fields = event.currentTarget.elements, button = event.currentTarget.querySelector("button[type=submit]");
    if (!confirm("Permanently delete this account and revoke all player links?")) return;
    button.disabled = true; status("#customer-delete-status", "");
    try {
      await request("delete", { password: fields.password.value, confirmation: fields.confirmation.value });
      account.clear();
    } catch (error) { status("#customer-delete-status", error.message); }
    finally { button.disabled = false; event.currentTarget.reset(); }
  });
  document.querySelector("#close-recovery").addEventListener("click", () => recovery.close());
  recovery.addEventListener("close", () => { document.querySelector("#customer-recovery-code").textContent = ""; document.querySelector("#customer-recovery-user").textContent = ""; });
  document.querySelector("#copy-recovery").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(document.querySelector("#customer-recovery-code").textContent); status("#recovery-status", "Copied"); }
    catch { status("#recovery-status", "Clipboard unavailable"); }
  });
  document.querySelector("#download-recovery").addEventListener("click", () => {
    const data = `Boss Media Servers\nUsername: ${account.customer.username}\nRecovery code: ${document.querySelector("#customer-recovery-code").textContent}\n`;
    const url = URL.createObjectURL(new Blob([data], { type: "text/plain" })), link = document.createElement("a");
    link.href = url; link.download = "boss-recovery.txt"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  paint();
  account.ready = (async () => {
    if (/\/admin\/?$/.test(location.pathname)) { account.mode = "admin"; paint(); return; }
    try {
      const response = await fetch(`${base}/account/me`, { credentials: "same-origin" });
      if (response.status === 404) account.mode = "admin";
      else {
        account.mode = "customer";
        if (response.ok) { const result = await response.json(); account.customer = result.customer; account.csrfToken = result.csrfToken; account.vault = result.vault; }
        else if (response.status !== 401) throw new Error("Account service is unavailable");
      }
    } catch { account.mode = "customer"; status("#customer-form-status", "Account service is unavailable"); }
    paint();
  })();
})();
