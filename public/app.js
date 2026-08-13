const state = {
  loggedIn: false,
  servers: [],
  libraries: [],
  selectedServer: null,
  selectedLibrary: null,
  searchTimer: null,
  activeSearch: 0,
  authPoll: null,
  indexPoll: null,
  browseMode: "recent",
  artist: "",
  album: "",
  offset: 0,
  totalItems: 0,
  hasMore: false,
  loadingPage: false,
  pageSerial: 0,
  queuedSearch: false,
  preservingEmptySpace: false,
};

const PAGE_SIZE = 120;
const THEME_STORAGE_KEY = "ptd:theme";
const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");

const els = {
  statusText: document.querySelector("#statusText"),
  themeBtn: document.querySelector("#themeBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  signinView: document.querySelector("#signinView"),
  signinBtn: document.querySelector("#signinBtn"),
  pinPanel: document.querySelector("#pinPanel"),
  pinCode: document.querySelector("#pinCode"),
  authLink: document.querySelector("#authLink"),
  pickerView: document.querySelector("#pickerView"),
  serverSelect: document.querySelector("#serverSelect"),
  librarySelect: document.querySelector("#librarySelect"),
  searchStickSentinel: document.querySelector("#searchStickSentinel"),
  searchView: document.querySelector("#searchView"),
  searchInput: document.querySelector("#searchInput"),
  metaLine: document.querySelector("#metaLine"),
  indexStatus: document.querySelector("#indexStatus"),
  browseTabs: document.querySelector("#browseTabs"),
  crumbs: document.querySelector("#crumbs"),
  errorBox: document.querySelector("#errorBox"),
  results: document.querySelector("#results"),
  pager: document.querySelector("#pager"),
  loadMoreBtn: document.querySelector("#loadMoreBtn"),
  pageStatus: document.querySelector("#pageStatus"),
  scrollSentinel: document.querySelector("#scrollSentinel"),
  trackTemplate: document.querySelector("#trackTemplate"),
};

function storedTheme() {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "light" || value === "dark" ? value : "system";
}

function resolvedTheme(mode = storedTheme()) {
  if (mode === "system") return themeMedia.matches ? "dark" : "light";
  return mode;
}

function applyTheme(mode = storedTheme()) {
  const resolved = resolvedTheme(mode);
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.dataset.theme = resolved;
  els.themeBtn.title = `Theme: ${mode}`;
  els.themeBtn.setAttribute("aria-label", `Theme: ${mode}`);
}

function cycleTheme() {
  const current = storedTheme();
  const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
  if (next === "system") {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } else {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  }
  applyTheme(next);
}

applyTheme();
const handleThemeMediaChange = () => {
  if (storedTheme() === "system") applyTheme("system");
};
if (themeMedia.addEventListener) {
  themeMedia.addEventListener("change", handleThemeMediaChange);
} else {
  themeMedia.addListener(handleThemeMediaChange);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed");
    error.details = payload.details;
    throw error;
  }
  return payload;
}

function formatError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  const attempts = error.details?.attempts || [];
  if (!attempts.length) return error.message || "Request failed";
  return [
    error.message,
    ...attempts.map((attempt) => {
      const kind = attempt.local ? "local" : attempt.relay ? "relay" : "remote";
      return `${kind}: ${attempt.error} (${attempt.uri})`;
    }),
  ].join("\n");
}

function showError(error = "") {
  const message = formatError(error);
  els.errorBox.textContent = message;
  els.errorBox.classList.toggle("hidden", !message);
}

function setStatus(message) {
  els.statusText.textContent = message;
}

function setSignedIn(loggedIn) {
  state.loggedIn = loggedIn;
  els.logoutBtn.classList.toggle("hidden", !loggedIn);
  els.signinView.classList.toggle("hidden", loggedIn);
  els.pickerView.classList.toggle("hidden", !loggedIn);
  els.searchView.classList.toggle("hidden", !loggedIn);
  els.browseTabs.classList.toggle("hidden", !loggedIn);
}

function selectedServerParts() {
  const value = els.serverSelect.value;
  const [serverId, encodedUri] = value.split("|");
  return {
    serverId,
    uri: decodeURIComponent(encodedUri || ""),
  };
}

function queryString(params) {
  return new URLSearchParams(params).toString();
}

function libraryParams(extra = {}) {
  const { serverId, uri } = selectedServerParts();
  return {
    serverId,
    uri,
    sectionKey: state.selectedLibrary || "",
    ...extra,
  };
}

function resetPaging() {
  state.offset = 0;
  state.totalItems = 0;
  state.hasMore = false;
  state.loadingPage = false;
  state.pageSerial += 1;
  updatePager();
}

function updatePager() {
  els.pager.classList.toggle("hidden", state.totalItems === 0 && !state.loadingPage);
  els.loadMoreBtn.disabled = state.loadingPage;
  els.loadMoreBtn.classList.toggle("hidden", !state.hasMore && !state.loadingPage);
  els.loadMoreBtn.textContent = state.loadingPage ? "Loading..." : "Load More";
  if (state.totalItems) {
    const shown = Math.min(state.offset, state.totalItems);
    els.pageStatus.textContent = `${shown.toLocaleString()} of ${state.totalItems.toLocaleString()}`;
  } else {
    els.pageStatus.textContent = state.loadingPage ? "Loading..." : "";
  }
}

function applyPage(payload) {
  const count = payload.items?.length ?? payload.tracks?.length ?? 0;
  state.totalItems = Number(payload.totalItems || payload.total || count || 0);
  state.offset = Number(payload.offset || state.offset) + count;
  state.hasMore = state.offset < state.totalItems;
  state.loadingPage = false;
  updatePager();
}

function preserveEmptyResultsSpace() {
  if (!els.searchView.classList.contains("is-stuck")) return;
  const height = Math.ceil(els.results.getBoundingClientRect().height);
  if (height <= 0) return;
  els.results.style.minHeight = `${height}px`;
  els.results.classList.add("is-preserving-space");
  state.preservingEmptySpace = true;
}

function releaseEmptyResultsSpace() {
  if (!state.preservingEmptySpace) return;
  els.results.style.minHeight = "";
  els.results.classList.remove("is-preserving-space");
  state.preservingEmptySpace = false;
}

function renderServers() {
  const options = [];
  for (const server of state.servers) {
    const auto = document.createElement("option");
    auto.value = `${server.id}|`;
    auto.textContent = `${server.name} - auto`;
    options.push(auto);

    for (const connection of server.connections) {
      const option = document.createElement("option");
      option.value = `${server.id}|${encodeURIComponent(connection.uri)}`;
      const kind = connection.local ? "local" : connection.relay ? "relay" : "remote";
      option.textContent = `${server.name} - ${kind} ${connection.uri}`;
      options.push(option);
    }
  }
  els.serverSelect.replaceChildren(...options);
}

function applyActiveUri(uri) {
  if (!uri) return;
  const { serverId } = selectedServerParts();
  const value = `${serverId}|${encodeURIComponent(uri)}`;
  if ([...els.serverSelect.options].some((option) => option.value === value)) {
    els.serverSelect.value = value;
  }
}

function renderLibraries() {
  const preferredLibrary =
    state.libraries.find((library) => library.title?.toLowerCase() === "music")
    || state.libraries.find((library) => library.title?.toLowerCase().includes("music"))
    || state.libraries[0];
  const options = state.libraries.map((library) => {
    const option = document.createElement("option");
    option.value = library.key;
    option.textContent = library.title;
    option.selected = library.key === preferredLibrary?.key;
    return option;
  });
  els.librarySelect.replaceChildren(...options);
  state.selectedLibrary = preferredLibrary ? String(preferredLibrary.key) : null;
  els.searchInput.disabled = !state.selectedLibrary;
  els.metaLine.textContent = state.selectedLibrary
    ? "Ready. Search for a track and download the original file."
    : "No music libraries found on this server connection.";
  els.browseTabs.classList.toggle("hidden", !state.selectedLibrary);
}

async function loadServers() {
  setStatus("Loading owned Plex servers...");
  const payload = await api("/api/servers");
  state.servers = payload.servers;
  renderServers();
  if (!state.servers.length) {
    setStatus("No owned Plex servers found.");
    els.pickerView.classList.add("hidden");
    els.searchView.classList.add("hidden");
    return;
  }
  await loadLibraries();
}

async function loadLibraries() {
  showError();
  releaseEmptyResultsSpace();
  els.results.replaceChildren();
  resetPaging();
  state.libraries = [];
  state.selectedLibrary = null;
  els.librarySelect.replaceChildren();
  els.searchInput.disabled = true;
  els.metaLine.textContent = "Checking server connections...";

  const { serverId, uri } = selectedServerParts();
  setStatus("Loading music libraries...");
  const payload = await api(`/api/libraries?${queryString({ serverId, uri })}`);
  applyActiveUri(payload.serverUri);
  state.libraries = payload.libraries;
  renderLibraries();
  const connection = payload.connection?.relay ? "relay" : payload.connection?.local ? "local" : "remote";
  setStatus(state.libraries.length ? `Connected via ${connection}.` : `Connected via ${connection}, but no music libraries were found.`);
  if (state.selectedLibrary) {
    state.browseMode = "recent";
    state.artist = "";
    state.album = "";
    await startIndex();
    await loadBrowse({ reset: true });
    els.searchInput.focus();
  }
}

function downloadUrl(track) {
  return `/download?${queryString({
    ...libraryParams(),
    ratingKey: track.ratingKey,
    partIndex: 0,
  })}`;
}

function renderCrumbs() {
  const parts = [];
  if (state.artist) parts.push(state.artist);
  if (state.album) parts.push(state.album);
  els.crumbs.textContent = parts.join(" / ");
  els.crumbs.classList.toggle("hidden", !parts.length);
}

function setBrowseMode(mode) {
  state.browseMode = mode;
  if (mode === "recent" || mode === "artists") {
    state.artist = "";
    state.album = "";
  }
  if (mode === "albums") state.album = "";
  for (const button of els.browseTabs.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.mode === mode);
  }
  renderCrumbs();
}

function trackRow(track) {
  const row = els.trackTemplate.content.firstElementChild.cloneNode(true);
  const title = row.querySelector("h2");
  const artist = row.querySelector(".artist");
  const album = row.querySelector(".album");
  const tech = row.querySelector(".track-tech");
  const link = row.querySelector(".download-button");

  title.textContent = track.title;
  artist.textContent = track.artist || "Unknown artist";
  album.textContent = [track.album, track.year].filter(Boolean).join(" - ");
  tech.textContent = [track.duration, track.codec, track.bitrate, track.size].filter(Boolean).join(" | ");
  link.href = downloadUrl(track);
  link.classList.toggle("disabled", !track.hasDownload);
  if (!track.hasDownload) link.removeAttribute("href");
  return row;
}

function renderTracks(tracks, { append = false, reserveEmpty = false } = {}) {
  if (!tracks.length) {
    if (append) return;
    if (reserveEmpty) preserveEmptyResultsSpace();
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = els.searchInput.value.trim().length < 2 ? "Type at least two characters." : "No tracks found.";
    els.results.replaceChildren(empty);
    return;
  }

  if (!append) releaseEmptyResultsSpace();
  const rows = tracks.map(trackRow);
  if (append) {
    els.results.append(...rows);
  } else {
    els.results.replaceChildren(...rows);
  }
}

function browseRow(item, mode) {
  const button = document.createElement("button");
  button.className = "browse-row";
  const main = document.createElement("span");
  main.className = "browse-main";
  main.textContent = item.name || item.title;
  const sub = document.createElement("span");
  sub.className = "browse-sub";
  sub.textContent = mode === "artists"
    ? `${item.count} track${item.count === 1 ? "" : "s"}`
    : [item.artist, item.year, `${item.count} track${item.count === 1 ? "" : "s"}`].filter(Boolean).join(" | ");
  button.append(main, sub);
  button.addEventListener("click", () => {
    if (mode === "artists") {
      state.artist = item.name;
      setBrowseMode("albums");
    } else {
      state.artist = item.artist;
      state.album = item.title;
      setBrowseMode("tracks");
    }
    loadBrowse({ reset: true }).catch((error) => showError(error));
  });
  return button;
}

function renderBrowseItems(payload, { append = false } = {}) {
  if (!append) releaseEmptyResultsSpace();
  if (payload.mode === "artists" || payload.mode === "albums") {
    const rows = payload.items.map((item) => browseRow(item, payload.mode));
    if (append) {
      els.results.append(...rows);
    } else {
      els.results.replaceChildren(...rows);
    }
    return;
  }
  renderTracks(payload.items, { append });
}

function updateIndexStatus(status) {
  const total = status.total || status.loaded || 0;
  if (status.status === "ready") {
    els.indexStatus.textContent = `Indexed ${status.loaded.toLocaleString()} tracks`;
  } else if (status.status === "indexing") {
    els.indexStatus.textContent = total
      ? `Indexing ${status.loaded.toLocaleString()} / ${total.toLocaleString()}`
      : `Indexing ${status.loaded.toLocaleString()}`;
  } else if (status.status === "error") {
    els.indexStatus.textContent = "Index failed";
  } else {
    els.indexStatus.textContent = "Index idle";
  }
}

async function pollIndex() {
  if (!state.selectedLibrary) return;
  const payload = await api(`/api/index/status?${queryString(libraryParams())}`);
  updateIndexStatus(payload);
  if (!els.searchInput.value.trim() && !els.results.children.length && payload.loaded > 0) {
    await loadBrowse({ reset: true });
  }
  if (payload.status === "ready" || payload.status === "error") {
    window.clearInterval(state.indexPoll);
    state.indexPoll = null;
  }
}

async function startIndex() {
  window.clearInterval(state.indexPoll);
  state.indexPoll = null;
  const payload = await api(`/api/index/start?${queryString(libraryParams())}`, { method: "POST" });
  updateIndexStatus(payload);
  state.indexPoll = window.setInterval(() => {
    pollIndex().catch(() => {});
  }, 1200);
}

async function loadBrowse({ reset = false, append = false } = {}) {
  if (!state.selectedLibrary) return;
  if (state.loadingPage) return;
  if (reset) {
    resetPaging();
    releaseEmptyResultsSpace();
    els.results.replaceChildren();
  }
  const serial = state.pageSerial;
  state.loadingPage = true;
  updatePager();
  showError();
  renderCrumbs();
  try {
    const payload = await api(`/api/browse?${queryString(libraryParams({
      mode: state.browseMode,
      artist: state.artist,
      album: state.album,
      offset: state.offset,
      limit: PAGE_SIZE,
    }))}`);
    if (serial !== state.pageSerial) return;
    if (payload.serverUri) applyActiveUri(payload.serverUri);
    updateIndexStatus(payload);
    renderBrowseItems(payload, { append });
    applyPage(payload);
    els.metaLine.textContent = payload.status === "indexing"
      ? `${state.totalItems.toLocaleString()} ${state.browseMode} while indexing`
      : `${state.totalItems.toLocaleString()} ${state.browseMode}`;
  } catch (error) {
    if (serial === state.pageSerial) {
      state.loadingPage = false;
      updatePager();
    }
    throw error;
  }
}

async function searchTracks({ reset = false, append = false, keepResults = false } = {}) {
  const q = els.searchInput.value.trim();
  if (!state.selectedLibrary || q.length < 2) {
    if (reset) resetPaging();
    if (!append && !keepResults) renderTracks([]);
    return;
  }

  if (state.loadingPage) {
    if (!append) {
      state.activeSearch += 1;
      state.queuedSearch = true;
      els.searchView.classList.add("is-searching");
      els.metaLine.textContent = "Searching...";
    }
    return;
  }
  const searchId = ++state.activeSearch;
  if (reset) {
    resetPaging();
    if (!keepResults) els.results.replaceChildren();
  }
  const serial = state.pageSerial;
  state.loadingPage = true;
  updatePager();
  els.searchView.classList.toggle("is-searching", !append);
  const { serverId, uri } = selectedServerParts();
  els.metaLine.textContent = append ? "Loading more..." : "Searching...";
  try {
    const payload = await api(`/api/search?${queryString({
      serverId,
      uri,
      sectionKey: state.selectedLibrary,
      q,
      offset: state.offset,
      limit: PAGE_SIZE,
    })}`);
    if (searchId !== state.activeSearch || serial !== state.pageSerial) {
      state.loadingPage = false;
      updatePager();
      if (!append && state.queuedSearch) {
        state.queuedSearch = false;
        searchTracks({ reset: true, keepResults: true }).catch((error) => showError(error));
      } else if (!append) {
        els.searchView.classList.remove("is-searching");
      }
      return;
    }
    applyActiveUri(payload.serverUri);
    renderTracks(payload.tracks, { append, reserveEmpty: !append });
    applyPage({
      items: payload.tracks,
      offset: payload.offset,
      totalItems: payload.totalItems,
    });
    updateIndexStatus(payload.index || {});
    els.metaLine.textContent = `${state.totalItems.toLocaleString()} result${state.totalItems === 1 ? "" : "s"}${payload.source ? ` from ${payload.source}` : ""}`;
    els.searchView.classList.remove("is-searching");
    if (!append && state.queuedSearch) {
      state.queuedSearch = false;
      searchTracks({ reset: true, keepResults: true }).catch((error) => showError(error));
    }
  } catch (error) {
    if (searchId !== state.activeSearch) return;
    state.loadingPage = false;
    state.queuedSearch = false;
    updatePager();
    els.searchView.classList.remove("is-searching");
    showError(error);
    els.metaLine.textContent = "Search failed.";
  }
}

async function startSignin() {
  showError();
  els.signinBtn.disabled = true;
  setStatus("Creating Plex sign-in PIN...");
  try {
    const payload = await api("/api/auth/start", { method: "POST" });
    els.pinPanel.classList.remove("hidden");
    els.pinCode.textContent = payload.code;
    els.authLink.href = payload.authUrl;
    localStorage.setItem("ptd:pendingPin", JSON.stringify({ id: payload.id, createdAt: Date.now() }));
    window.open(payload.authUrl, "_blank", "noopener,noreferrer");
    setStatus("Finish sign-in at Plex, then this page will continue.");
    pollSignin(payload.id, Date.now());
  } catch (error) {
    els.signinBtn.disabled = false;
    showError(error);
    setStatus("Sign-in could not start.");
  }
}

function pollSignin(pinId, startedAt) {
  if (state.authPoll) window.clearInterval(state.authPoll);
  els.signinBtn.disabled = true;
  state.authPoll = window.setInterval(async () => {
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      window.clearInterval(state.authPoll);
      state.authPoll = null;
      localStorage.removeItem("ptd:pendingPin");
      els.signinBtn.disabled = false;
      setStatus("Plex sign-in timed out.");
      return;
    }
    try {
      const result = await api(`/api/auth/poll?${queryString({ id: pinId })}`);
      if (!result.complete) return;
      window.clearInterval(state.authPoll);
      state.authPoll = null;
      localStorage.removeItem("ptd:pendingPin");
      els.pinPanel.classList.add("hidden");
      setSignedIn(true);
      await loadServers();
    } catch (error) {
      window.clearInterval(state.authPoll);
      state.authPoll = null;
      localStorage.removeItem("ptd:pendingPin");
      els.signinBtn.disabled = false;
      showError(error);
    }
  }, 1200);
}

async function logout() {
  await api("/api/auth/logout", { method: "POST" });
  setSignedIn(false);
  localStorage.removeItem("ptd:pendingPin");
  window.clearInterval(state.indexPoll);
  state.indexPoll = null;
  resetPaging();
  releaseEmptyResultsSpace();
  els.results.replaceChildren();
  els.searchInput.value = "";
  setStatus("Signed out.");
}

function loadNextPage() {
  if (!state.selectedLibrary || state.loadingPage || !state.hasMore) return;
  if (els.searchInput.value.trim().length >= 2) {
    searchTracks({ append: true }).catch((error) => showError(error));
  } else {
    loadBrowse({ append: true }).catch((error) => showError(error));
  }
}

function resumePendingSignin() {
  try {
    const pending = JSON.parse(localStorage.getItem("ptd:pendingPin") || "null");
    if (!pending?.id) return;
    els.pinPanel.classList.remove("hidden");
    els.pinCode.textContent = "";
    setStatus("Checking Plex sign-in...");
    pollSignin(pending.id, pending.createdAt || Date.now());
  } catch {
    localStorage.removeItem("ptd:pendingPin");
  }
}

els.signinBtn.addEventListener("click", startSignin);
els.themeBtn.addEventListener("click", cycleTheme);
els.logoutBtn.addEventListener("click", logout);
els.serverSelect.addEventListener("change", () => {
  loadLibraries().catch((error) => showError(error));
});
els.librarySelect.addEventListener("change", () => {
  state.selectedLibrary = els.librarySelect.value;
  state.browseMode = "recent";
  state.artist = "";
  state.album = "";
  resetPaging();
  releaseEmptyResultsSpace();
  els.results.replaceChildren();
  startIndex()
    .then(() => loadBrowse({ reset: true }))
    .catch((error) => showError(error));
  els.searchInput.focus();
});
els.searchInput.addEventListener("input", () => {
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    if (els.searchInput.value.trim().length < 2) {
      loadBrowse({ reset: true }).catch((error) => showError(error));
    } else {
      searchTracks({ reset: true, keepResults: true });
    }
  }, 80);
});
els.browseTabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (!button) return;
  els.searchInput.value = "";
  setBrowseMode(button.dataset.mode);
  loadBrowse({ reset: true }).catch((error) => showError(error));
});
els.loadMoreBtn.addEventListener("click", loadNextPage);

const observer = new IntersectionObserver((entries) => {
  if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
}, {
  rootMargin: "900px 0px",
});
observer.observe(els.scrollSentinel);

const stickyObserver = new IntersectionObserver((entries) => {
  const entry = entries[0];
  const isStuck = !entry.isIntersecting && !els.searchView.classList.contains("hidden");
  els.searchView.classList.toggle("is-stuck", isStuck);
  if (!isStuck) releaseEmptyResultsSpace();
}, {
  threshold: 0,
});
stickyObserver.observe(els.searchStickSentinel);

api("/api/session")
  .then(async (session) => {
    setSignedIn(session.loggedIn);
    if (session.loggedIn) {
      await loadServers();
    } else {
      resumePendingSignin();
    }
  })
  .catch((error) => showError(error));

window.addEventListener("focus", () => {
  api("/api/session")
    .then(async (session) => {
      if (!session.loggedIn || state.loggedIn) return;
      setSignedIn(true);
      localStorage.removeItem("ptd:pendingPin");
      await loadServers();
    })
    .catch(() => {});
});
