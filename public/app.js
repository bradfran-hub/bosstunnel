"use strict";
const form = document.querySelector("#addon-form");
const fields = form.elements;
const list = document.querySelector("#addon-list");
const output = document.querySelector("#form-output");
const dialog = document.querySelector("#delete-dialog");
const base = location.pathname.replace(/\/workspace\/?$/, "").replace(/\/$/, "");
let pendingDelete;
let busy = false;
let savedSources = [];
let savedLibraries = [];
let refreshTimer;
let editingLibrary = null;
let editingSource = null;
let refreshVersion = 0;
let workspaceToken = "";
let metricsUpdatedAt = 0;
let reviewVersion = 0;
let reviewNext = null;
const reviewPanel = document.querySelector("#identity-reviews");
async function loadReviews(after = 0) {
  const version = ++reviewVersion, token = fields.adminToken.value.trim();
  const status = document.querySelector("#review-status");
  const next = document.querySelector("#review-next");
  status.textContent = "Loading reviews...";
  next.hidden = true;
  document.querySelector("#review-list").replaceChildren();
  try {
    const result = await request(`/api/identity-reviews?after=${after}`);
    if (version !== reviewVersion || token !== fields.adminToken.value.trim()) return;
    const identities = values => Object.entries(values || {}).map(([name, value]) => `${escape(name.toUpperCase())}: ${escape(value)}`).join(" / ");
    document.querySelector("#review-list").innerHTML = result.reviews.map(review => `<article class="identity-review"><h3>${escape(review.title)}</h3><p>${escape(review.sourceName)} / ${escape(review.type)} / Pending review</p><dl><dt>Incoming identities</dt><dd>${identities(review.identities) || "None"}</dd>${review.matches.map(match => `<dt>Existing: ${escape(match.title)}${match.year ? ` (${escape(match.year)})` : ""}</dt><dd>${identities(match.identities)}<br>Matched by: ${escape(match.matchedBy.join(", "))}<br><code>${escape(match.canonicalId)}</code></dd>`).join("")}</dl></article>`).join("");
    status.textContent = result.reviews.length ? `${result.reviews.length} pending on this page` : "No pending reviews";
    reviewNext = result.next;
    next.hidden = reviewNext == null;
  } catch (error) {
    if (version === reviewVersion && token === fields.adminToken.value.trim()) status.textContent = error.message;
  }
}
reviewPanel.addEventListener("toggle", () => { if (reviewPanel.open && workspaceToken) loadReviews(); });
document.querySelector("#review-refresh").addEventListener("click", () => loadReviews());
document.querySelector("#review-next").addEventListener("click", () => { if (reviewNext != null) loadReviews(reviewNext); });
const format = document.querySelector("#output-format");
const names = { jellyfin: "Jellyfin", emby: "Emby", plex: "Plex", boss: "Boss addon", catalogue: "Catalogue source", webdav: "WebDAV", other: "Other source", xtream: "Xtream", m3u: "M3U playlist" };
const icons = () => lucide.createIcons();
const escape = (value) => String(value || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function show(message, error = false) { output.hidden = false; output.textContent = message; output.classList.toggle("error", error); }
function payload() {
  const type = fields.sourceType.value;
  return { name: fields.addonName.value, sourceType: type, baseUrl: fields.baseUrl.value, apiKey: fields.apiKey.value, userId: fields.userId.value, libraryPath: type === "webdav" ? fields.libraryPath.value : fields.libraryId.value, username: fields.username.value, password: fields.password.value, xmltvUrl: fields.xmltvUrl.value, enableCatchup: fields.enableCatchup.checked, ...(editingSource ? { revision: editingSource.revision, addonUrl: "", replaceCredentials: fields.replaceCredentials.checked } : {}) };
}
async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "Content-Type": "application/json", "X-Boss-Admin": fields.adminToken.value.trim() } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function empty(title, message, icon = "folder-open") {
  list.innerHTML = `<div class="empty"><i data-lucide="${icon}"></i><h3>${escape(title)}</h3><p>${escape(message)}</p></div>`; icons();
}
function exportView(addon) {
  if (format.value === "xtream") return `<dl class="credentials">${[["Server", addon.xtream.server], ["Username", addon.xtream.username], ["Password", addon.xtream.password]].map(([label, value]) => `<dt>${label}</dt><dd><code>${escape(value)}</code><button class="icon-button" data-copy="${escape(value)}" title="Copy ${label.toLowerCase()}" aria-label="Copy ${label.toLowerCase()}"><i data-lucide="copy"></i></button></dd>`).join("")}</dl>`;
  const url = format.value === "m3u" ? addon.playlistUrl : format.value === "compatibility" ? addon.compatibilityUrl : addon.bossUrl;
  return `<code class="install-url">${escape(url)}</code><div class="addon-actions"><a href="${escape(url)}" target="_blank" rel="noreferrer">${format.value === "m3u" ? "Download playlist" : "Open addon"}<i data-lucide="arrow-up-right"></i></a><button data-copy="${escape(url)}"><i data-lucide="copy"></i>Copy ${format.value === "m3u" ? "playlist" : "install"} URL</button></div>`;
}
function render() {
  list.innerHTML = savedSources.map((addon) => {
    const failed = addon.sync?.status === "failed" || addon.jobs?.some((job) => job.status === "failed");
    const review = addon.jobs?.some(job => job.error_code === "IDENTITY_REVIEW");
    const status = addon.syncing ? "Syncing" : failed ? "Sync failed" : review ? "Identity review needed" : "Ready";
    const count = (addon.jobs || []).reduce((total, job) => total + job.imported_count, 0);
    return `<article class="addon-card"><div class="addon-top"><div><h3>${escape(addon.name)}</h3><span class="source-label"><i data-lucide="${failed ? "circle-alert" : addon.syncing ? "loader-circle" : "circle-check"}"></i>${escape(names[addon.sourceType])} · ${status} · ${count} records</span></div><div><button class="icon-button" data-edit-source="${escape(addon.id)}" title="Edit source" aria-label="Edit ${escape(addon.name)}" ${addon.syncing ? "disabled" : ""}><i data-lucide="pencil"></i></button><button class="icon-button" data-sync="${escape(addon.id)}" title="Sync catalogue" aria-label="Sync ${escape(addon.name)}" ${addon.syncing ? "disabled" : ""}><i data-lucide="refresh-cw"></i></button><button class="icon-button" data-delete="${escape(addon.id)}" title="Remove source" aria-label="Remove ${escape(addon.name)}"><i data-lucide="trash-2"></i></button></div></div>${exportView(addon)}<div class="addon-date">Created ${escape(new Date(addon.createdAt).toLocaleDateString())}</div></article>`;
  }).join("");
  const selected = new Set([...document.querySelectorAll('#library-sources input:checked')].map((input) => input.value));
  const sourcePicker = document.querySelector("#library-sources");
  const pickerVersion = JSON.stringify(savedSources.map(({ id, name, sourceType }) => [id, name, sourceType]));
  if (sourcePicker.dataset.version !== pickerVersion) {
    sourcePicker.innerHTML = savedSources.map((source) => `<label><input type="checkbox" value="${escape(source.id)}" ${selected.has(source.id) ? "checked" : ""}>${escape(source.name)} <small>${escape(names[source.sourceType])}</small></label>`).join("");
    sourcePicker.dataset.version = pickerVersion;
  }
  document.querySelector("#library-list").innerHTML = savedLibraries.filter((library) => !savedSources.some((source) => source.id === library.id)).map((library) => `<article class="addon-card"><div class="addon-top"><div><h3>${escape(library.name)}</h3><span class="source-label">${library.sourceIds.length} sources</span></div><div><button class="icon-button" data-edit-library="${escape(library.id)}" title="Edit library" aria-label="Edit ${escape(library.name)}"><i data-lucide="pencil"></i></button><button class="icon-button" data-remove-library="${escape(library.id)}" title="Remove library" aria-label="Remove ${escape(library.name)}"><i data-lucide="trash-2"></i></button></div></div>${exportView(library)}</article>`).join("");
  icons();
}
format.addEventListener("change", () => { if (savedSources.length || savedLibraries.length) render(); });
async function refresh(options = {}) {
  const version = ++refreshVersion;
  const token = fields.adminToken.value.trim();
  const background = options.background === true && token === workspaceToken;
  clearTimeout(refreshTimer);
  if (!background) {
    reviewVersion++;
    reviewNext = null;
    reviewPanel.open = false;
    document.querySelector("#review-list").replaceChildren();
    document.querySelector("#review-status").textContent = "";
    document.querySelector("#review-next").hidden = true;
    metricsUpdatedAt = 0;
    document.querySelector("#catalogue-health").hidden = true;
    savedSources = [];
    savedLibraries = [];
    workspaceToken = "";
    document.querySelector("#libraries-section").hidden = true;
    document.querySelector("#library-list").replaceChildren();
  }
  if (!token) { workspaceToken = ""; cancelLibraryEdit(); const picker = document.querySelector("#library-sources"); picker.replaceChildren(); delete picker.dataset.version; document.querySelector("#source-count").textContent = "0"; return empty("Workspace locked", "Admin access required", "lock-keyhole"); }
  if (!background) empty("Loading addons", "Connecting to your workspace", "loader-circle");
  try {
    const { addons } = await request("/api/addons");
    if (version !== refreshVersion || token !== fields.adminToken.value.trim()) return;
    const { libraries } = await request("/api/libraries");
    if (version !== refreshVersion || token !== fields.adminToken.value.trim()) return;
    savedLibraries = libraries;
    workspaceToken = token;
    document.querySelector("#libraries-section").hidden = false;
    document.querySelector("#source-count").textContent = addons.length;
    savedSources = addons; render();
    if (Date.now() - metricsUpdatedAt >= 30000) {
      try {
        const catalogue = await request("/api/catalogue-status");
        const evidence = await request("/api/playback-evidence");
        if (version !== refreshVersion || token !== fields.adminToken.value.trim()) return;
        for (const type of ["movie", "series"]) {
          const count = catalogue.counts[type] || 0;
          document.querySelector(`#${type}-total`).textContent = count.toLocaleString();
        }
        document.querySelector("#transfer-total").textContent = evidence.successfulTransfers.toLocaleString();
        document.querySelector("#transfer-other").textContent = [evidence.probes, evidence.interruptions, evidence.failures].map(value => value.toLocaleString()).join(" / ");
        const running = addons.filter(addon => addon.syncing).length;
        document.querySelector("#catalogue-refresh-status").textContent = running ? `${running} syncing` : "Scheduled daily";
        metricsUpdatedAt = Date.now();
        document.querySelector("#catalogue-updated").textContent = `Updated ${new Date(metricsUpdatedAt).toLocaleTimeString()}`;
        document.querySelector("#catalogue-health").hidden = false;
      } catch {
        if (version !== refreshVersion || token !== fields.adminToken.value.trim()) return;
        document.querySelector("#catalogue-updated").textContent = "Statistics unavailable";
      }
    }
    if (!addons.length) empty("No addons yet", "Your connected libraries will appear here.");
    refreshTimer = setTimeout(() => refresh({ background: true }), addons.some((addon) => addon.syncing) ? 2000 : 30000);
  } catch (error) {
    if (version !== refreshVersion || token !== fields.adminToken.value.trim()) return;
    if (background) refreshTimer = setTimeout(() => refresh({ background: true }), 5000);
    else empty("Workspace unavailable", error.message, "lock-keyhole");
  }
}
function sourceChanged() {
  const type = fields.sourceType.value;
  document.querySelectorAll("[data-for]").forEach((el) => { el.hidden = !el.dataset.for.split(" ").includes(type); });
  document.querySelector("#url-label").textContent = ["other", "boss", "catalogue"].includes(type) ? "Source addon URL" : type === "m3u" ? "Playlist URL" : "Server URL";
  fields.baseUrl.placeholder = type === "boss" ? "https://source.example.com/addon.boss" : ["other", "catalogue"].includes(type) ? "https://source.example.com/addon" : "https://media.example.com";
  const credentialsRequired = !editingSource || fields.replaceCredentials.checked;
  fields.apiKey.required = credentialsRequired && ["jellyfin", "emby", "plex"].includes(type);
  fields.username.required = credentialsRequired && type === "xtream";
  fields.password.required = credentialsRequired && type === "xtream";
  for (const name of ["apiKey", "username", "password"]) fields[name].placeholder = editingSource && !fields.replaceCredentials.checked ? "Unchanged" : "";
  output.hidden = true;
}
async function submit(probe) {
  if (busy || !form.reportValidity()) return;
  busy = true; form.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  show(probe ? "Testing connection..." : "Connecting and creating addon...");
  try {
    const editing = editingSource;
    const endpoint = editing ? `/api/addons/${editing.id}${probe ? "/probe" : ""}` : probe ? "/api/probe" : "/api/addons";
    const data = await request(endpoint, { method: "POST", body: JSON.stringify(payload()) });
    if (!probe) { if (editing) cancelSourceEdit(); fields.apiKey.value = ""; fields.password.value = ""; await refresh(); }
    show(probe ? `Connection successful. ${data.count} items in the first catalog page.` : editing ? "Source saved." : "Addon created.");
  } catch (error) { show(error.message, true); }
  finally { busy = false; form.querySelectorAll("button").forEach((button) => { button.disabled = false; }); }
}
form.addEventListener("submit", (event) => { event.preventDefault(); submit(false); });
fields.sourceType.forEach((input) => input.addEventListener("change", sourceChanged));
fields.adminToken.addEventListener("change", refresh);
document.querySelector("#probe-btn").addEventListener("click", () => submit(true));
document.querySelector("#refresh-btn").addEventListener("click", refresh);
document.querySelector("#lock-btn").addEventListener("click", () => { fields.adminToken.value = ""; cancelSourceEdit(); output.hidden = true; refresh(); });
list.addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-source]");
  if (edit && !busy) {
    const token = fields.adminToken.value;
    try {
      const { source } = await request(`/api/addons/${edit.dataset.editSource}`);
      if (token !== fields.adminToken.value) return;
      editingSource = source;
      form.reset(); fields.adminToken.value = token;
      fields.sourceType.value = source.sourceType;
      fields.sourceType.forEach((input) => { input.disabled = true; });
      fields.addonName.value = source.name;
      const config = source.configuration;
      fields.baseUrl.value = config.addonUrl || config.baseUrl;
      for (const name of ["userId", "xmltvUrl"]) fields[name].value = config[name] || "";
      fields[source.sourceType === "webdav" ? "libraryPath" : "libraryId"].value = config.libraryPath || "";
      fields.enableCatchup.checked = config.enableCatchup === true;
      document.querySelector("#builder-title").textContent = "Edit source";
      document.querySelector("#source-save-label").textContent = "Save source";
      document.querySelector("#cancel-source-edit").hidden = false;
      document.querySelector("#replace-credentials").hidden = false;
      sourceChanged(); form.scrollIntoView({ block: "start", behavior: "smooth" }); fields.addonName.focus({ preventScroll: true });
    } catch (error) { show(error.message, true); }
  }
  const sync = event.target.closest("[data-sync]");
  if (sync) { try { await request(`/api/addons/${sync.dataset.sync}/sync`, { method: "POST" }); await refresh(); } catch (error) { show(error.message, true); } }
  const copy = event.target.closest("[data-copy]");
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); const old = copy.innerHTML; copy.innerHTML = copy.classList.contains("icon-button") ? '<i data-lucide="check"></i>' : '<i data-lucide="check"></i>Copied'; icons(); setTimeout(() => { copy.innerHTML = old; icons(); }, 1600); }
    catch { show("Clipboard unavailable. Select the install URL to copy it.", true); }
  }
  const remove = event.target.closest("[data-delete]");
  if (remove) { pendingDelete = remove.dataset.delete; dialog.showModal(); }
});
function cancelSourceEdit() {
  const token = fields.adminToken.value;
  editingSource = null; form.reset(); fields.adminToken.value = token;
  fields.sourceType.forEach((input) => { input.disabled = false; });
  document.querySelector("#builder-title").textContent = "Connect a source";
  document.querySelector("#source-save-label").textContent = "Create addon";
  document.querySelector("#cancel-source-edit").hidden = true;
  document.querySelector("#replace-credentials").hidden = true;
  sourceChanged();
}
document.querySelector("#cancel-source-edit").addEventListener("click", cancelSourceEdit);
fields.replaceCredentials.addEventListener("change", sourceChanged);
document.querySelector("#library-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = document.querySelector("#library-status");
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const editing = editingLibrary;
    const inputs = event.currentTarget.elements;
    const profile = { codecs: inputs.codecs.value ? inputs.codecs.value.split(",") : [], maxHeight: Number(inputs.maxHeight.value), language: inputs.language.value, hdr: inputs.hdr.checked, strictCapabilities: inputs.strictCapabilities.checked };
    await request(editing ? `/api/libraries/${editing.id}` : "/api/libraries", { method: "POST", body: JSON.stringify({ name: inputs.libraryName.value, sourceIds: [...document.querySelectorAll('#library-sources input:checked')].map((input) => input.value), profile, ...(editing ? { revision: editing.revision } : {}) }) });
    status.textContent = editing ? "Library saved." : "Library created."; cancelLibraryEdit(); await refresh();
  } catch (error) { status.textContent = error.message; }
  finally { status.hidden = false; button.disabled = false; }
});
document.querySelector("#library-list").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-library]");
  if (edit) {
    editingLibrary = savedLibraries.find((library) => library.id === edit.dataset.editLibrary);
    const form = document.querySelector("#library-form");
    form.elements.libraryName.value = editingLibrary.name;
    const profile = editingLibrary.profile || {};
    for (const [name, value] of [["codecs", (profile.codecs || []).join(",")], ["maxHeight", String(profile.maxHeight || 0)]]) {
      const select = form.elements[name];
      if (![...select.options].some((option) => option.value === value)) select.add(new Option(value, value));
      select.value = value;
    }
    const language = profile.language || "";
    if (![...form.elements.language.options].some((option) => option.value === language)) form.elements.language.add(new Option(language, language));
    form.elements.language.value = language;
    form.elements.hdr.checked = profile.hdr !== false;
    form.elements.strictCapabilities.checked = profile.strictCapabilities === true;
    document.querySelectorAll('#library-sources input').forEach((input) => { input.checked = editingLibrary.sourceIds.includes(input.value); });
    document.querySelector("#library-save-label").textContent = "Save library";
    document.querySelector("#cancel-library-edit").hidden = false;
    document.querySelector("#library-status").hidden = true;
    form.scrollIntoView({ block: "center", behavior: "smooth" }); form.elements.libraryName.focus({ preventScroll: true });
  }
  const remove = event.target.closest("[data-remove-library]");
  if (remove) { if (!confirm("Remove this library and revoke its player URLs?")) return; try { await request(`/api/libraries/${remove.dataset.removeLibrary}`, { method: "DELETE" }); await refresh(); } catch (error) { show(error.message, true); } }
  const copy = event.target.closest("[data-copy]");
  if (copy) { try { await navigator.clipboard.writeText(copy.dataset.copy); } catch { show("Clipboard unavailable", true); } }
});
function cancelLibraryEdit() {
  editingLibrary = null;
  document.querySelector("#library-form").reset();
  document.querySelector("#library-save-label").textContent = "Create library";
  document.querySelector("#cancel-library-edit").hidden = true;
}
document.querySelector("#cancel-library-edit").addEventListener("click", cancelLibraryEdit);
document.querySelector("#cancel-delete").addEventListener("click", () => dialog.close());
document.querySelector("#confirm-delete").addEventListener("click", async () => {
  try { await request(`/api/addons/${pendingDelete}`, { method: "DELETE" }); dialog.close(); await refresh(); }
  catch (error) { dialog.close(); show(error.message, true); }
});
fetch(`${base}/healthz`).then((r) => { if (!r.ok) throw new Error(); document.querySelector("#service-status").textContent = "Service online"; document.querySelector(".top-status").classList.add("online"); }).catch(() => { document.querySelector("#service-status").textContent = "Service unavailable"; });
sourceChanged(); refresh(); icons();
