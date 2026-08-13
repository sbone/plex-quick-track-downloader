import { createServer } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

const ROOT = resolve(".");
const PUBLIC_ROOT = join(ROOT, "public");
const DATA_ROOT = join(ROOT, ".data");
const CLIENT_ID_PATH = join(DATA_ROOT, "client-id");
const PORT = Number(process.env.PORT || 8765);
const PRODUCT = "Plex Track Downloader";
const VERSION = "0.1.0";

const sessions = new Map();
const pendingPins = new Map();
const libraryIndexes = new Map();
const PIN_TTL_MS = 10 * 60 * 1000;
const INDEX_PAGE_SIZE = 500;

mkdirSync(DATA_ROOT, { recursive: true });

function getClientIdentifier() {
  if (existsSync(CLIENT_ID_PATH)) {
    return readFileSync(CLIENT_ID_PATH, "utf8").trim();
  }
  const id = randomUUID();
  writeFileSync(CLIENT_ID_PATH, `${id}\n`, { mode: 0o600 });
  return id;
}

const CLIENT_IDENTIFIER = getClientIdentifier();

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message, details = undefined) {
  sendJson(res, status, { error: message, details });
}

function parseCookies(req) {
  const cookies = {};
  for (const pair of (req.headers.cookie || "").split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    cookies[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return cookies;
}

function getSession(req, res) {
  const cookies = parseCookies(req);
  let sessionId = cookies.ptd_session;
  if (!sessionId || !sessions.has(sessionId)) {
    sessionId = randomUUID();
    sessions.set(sessionId, { id: sessionId, createdAt: Date.now() });
    res.setHeader("Set-Cookie", `ptd_session=${encodeURIComponent(sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
  }
  return sessions.get(sessionId);
}

function prunePendingPins() {
  const now = Date.now();
  for (const [id, pin] of pendingPins) {
    if (now - pin.createdAt > PIN_TTL_MS) pendingPins.delete(id);
  }
}

function plexHeaders(token = "") {
  const headers = {
    Accept: "application/json",
    "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
    "X-Plex-Product": PRODUCT,
    "X-Plex-Version": VERSION,
    "X-Plex-Platform": "Web",
    "X-Plex-Device": "Node.js",
    "X-Plex-Device-Name": PRODUCT,
  };
  if (token) headers["X-Plex-Token"] = token;
  return headers;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function assertJson(response, fallbackMessage) {
  const payload = await readResponse(response);
  if (!response.ok) {
    const message = typeof payload === "object" && payload?.errors?.length
      ? payload.errors.map((error) => error.message || error).join(", ")
      : fallbackMessage;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function plexTv(path, { method = "GET", token = "", params = {}, body = undefined } = {}) {
  const url = new URL(path, "https://plex.tv");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const headers = plexHeaders(token);
  let requestBody = undefined;
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    requestBody = new URLSearchParams(body);
  }

  const response = await fetch(url, { method, headers, body: requestBody });
  return assertJson(response, `Plex request failed: ${response.status}`);
}

function describeFetchError(error, uri) {
  const cause = error?.cause || error;
  if (cause?.code && cause?.address) {
    return `${cause.code} connecting to ${cause.address}:${cause.port || ""}`.replace(/:$/, "");
  }
  if (error?.name === "TimeoutError" || cause?.name === "TimeoutError") {
    return `Timed out connecting to ${uri}`;
  }
  return error?.message || `Could not connect to ${uri}`;
}

async function plexServer(baseUri, path, token, { params = {}, headers = {}, timeoutMs = 7000 } = {}) {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, baseUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  let response;
  try {
    response = await fetch(url, {
      headers: {
        ...plexHeaders(token),
        ...headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const wrapped = new Error(describeFetchError(error, baseUri));
    wrapped.status = 502;
    wrapped.cause = error;
    throw wrapped;
  }
  return assertJson(response, `Plex server request failed: ${response.status}`);
}

function requireAuth(session) {
  if (!session.token) {
    const error = new Error("Not signed in");
    error.status = 401;
    throw error;
  }
}

async function ownedServers(session) {
  requireAuth(session);
  const resources = await plexTv("/api/v2/resources", {
    token: session.token,
    params: { includeHttps: "1", includeRelay: "1" },
  });
  return resources
    .filter((resource) => resource.owned && String(resource.provides || "").split(",").includes("server"))
    .map((resource) => ({
      id: resource.clientIdentifier || resource.machineIdentifier || resource.name,
      name: resource.name,
      product: resource.product,
      platform: resource.platform,
      presence: Boolean(resource.presence),
      owned: Boolean(resource.owned),
      accessToken: resource.accessToken || session.token,
      connections: (resource.connections || []).map((connection) => ({
        uri: connection.uri,
        local: Boolean(connection.local),
        relay: Boolean(connection.relay),
        protocol: connection.protocol,
        address: connection.address,
        port: connection.port,
      })),
    }));
}

async function resolveServer(session, serverId, uri) {
  const servers = await ownedServers(session);
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    const error = new Error("Selected server is not available to this Plex account");
    error.status = 404;
    throw error;
  }
  const connection = uri
    ? server.connections.find((candidate) => candidate.uri === uri)
    : server.connections.find((candidate) => candidate.local) || server.connections[0];
  if (!connection) {
    const error = new Error("Selected server has no usable connection");
    error.status = 404;
    throw error;
  }
  return { ...server, uri: connection.uri };
}

function orderedConnections(server, preferredUri = "") {
  const seen = new Set();
  const preferred = preferredUri
    ? server.connections.filter((connection) => connection.uri === preferredUri)
    : [];
  const ranked = [
    ...preferred,
    ...server.connections.filter((connection) => !connection.relay),
    ...server.connections.filter((connection) => connection.relay),
  ];
  return ranked.filter((connection) => {
    if (!connection.uri || seen.has(connection.uri)) return false;
    seen.add(connection.uri);
    return true;
  });
}

async function plexServerAny(session, serverId, preferredUri, path, options = {}) {
  const server = await resolveServer(session, serverId, preferredUri || "");
  const attempts = [];
  for (const connection of orderedConnections(server, preferredUri || server.uri)) {
    try {
      const payload = await plexServer(connection.uri, path, server.accessToken, options);
      return {
        payload,
        server: { ...server, uri: connection.uri },
        connection,
        attempts,
      };
    } catch (error) {
      attempts.push({
        uri: connection.uri,
        local: connection.local,
        relay: connection.relay,
        error: error.message,
      });
    }
  }

  const error = new Error(`Could not reach Plex server "${server.name}" from this machine.`);
  error.status = 502;
  error.payload = { attempts };
  throw error;
}

async function plexBinaryAny(session, serverId, preferredUri, path, { headers = {}, timeoutMs = 7000 } = {}) {
  const server = await resolveServer(session, serverId, preferredUri || "");
  const attempts = [];
  for (const connection of orderedConnections(server, preferredUri || server.uri)) {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, connection.uri);
    try {
      const response = await fetch(url, {
        headers: {
          ...plexHeaders(server.accessToken),
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok && response.body) {
        return {
          response,
          server: { ...server, uri: connection.uri },
          connection,
          attempts,
        };
      }
      attempts.push({
        uri: connection.uri,
        local: connection.local,
        relay: connection.relay,
        error: `HTTP ${response.status}`,
      });
    } catch (error) {
      attempts.push({
        uri: connection.uri,
        local: connection.local,
        relay: connection.relay,
        error: describeFetchError(error, connection.uri),
      });
    }
  }

  const error = new Error(`Could not stream from Plex server "${server.name}" from this machine.`);
  error.status = 502;
  error.payload = { attempts };
  throw error;
}

function mediaContainerItems(payload, key) {
  const value = payload?.MediaContainer?.[key] || [];
  return Array.isArray(value) ? value : [value];
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function compactKey(serverId, sectionKey) {
  return `${serverId || ""}:${sectionKey || ""}`;
}

function firstItem(payload) {
  return mediaContainerItems(payload, "Metadata")[0];
}

function sectionIsMusic(section) {
  return section.type === "artist" || section.agent?.includes("music") || section.scanner?.includes("Music");
}

function firstPart(track, preferredIndex = 0) {
  const media = Array.isArray(track?.Media) ? track.Media : [];
  const parts = media.flatMap((item) => Array.isArray(item.Part) ? item.Part : []);
  return parts[preferredIndex] || parts[0] || null;
}

function formatDuration(ms) {
  const total = Math.round(Number(ms || 0) / 1000);
  if (!total) return "";
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = units[0];
  for (unit of units) {
    if (amount < 1000 || unit === units.at(-1)) break;
    amount /= 1000;
  }
  return `${amount >= 10 || unit === "B" ? Math.round(amount) : amount.toFixed(1)} ${unit}`;
}

function trackSummary(track) {
  const part = firstPart(track);
  const media = Array.isArray(track.Media) ? track.Media[0] : null;
  const addedAt = Number(track.addedAt || 0);
  const title = track.title || "Untitled";
  const artist = track.grandparentTitle || track.originalTitle || "";
  const album = track.parentTitle || "";
  return {
    ratingKey: track.ratingKey,
    key: track.key,
    title,
    artist,
    album,
    year: track.year || "",
    duration: formatDuration(track.duration),
    codec: media?.audioCodec || media?.container || part?.container || "",
    bitrate: media?.bitrate ? `${media.bitrate} kbps` : "",
    channels: media?.audioChannels || "",
    size: formatBytes(part?.size),
    file: part?.file || "",
    thumb: track.thumb || track.parentThumb || track.grandparentThumb || "",
    addedAt,
    hasDownload: Boolean(part?.key),
    searchText: normalizeText([title, artist, album, track.year, part?.file].filter(Boolean).join(" ")),
  };
}

function publicTrack(track) {
  const { searchText, thumb, file, ...publicFields } = track;
  return publicFields;
}

function indexStatus(index) {
  return {
    status: index?.status || "idle",
    loaded: index?.loaded || 0,
    total: index?.total || 0,
    serverUri: index?.serverUri || "",
    error: index?.error || "",
    updatedAt: index?.updatedAt || 0,
  };
}

function getLibraryIndex(serverId, sectionKey) {
  const key = compactKey(serverId, sectionKey);
  if (!libraryIndexes.has(key)) {
    libraryIndexes.set(key, {
      key,
      status: "idle",
      tracks: [],
      loaded: 0,
      total: 0,
      serverUri: "",
      error: "",
      promise: null,
      updatedAt: 0,
    });
  }
  return libraryIndexes.get(key);
}

function scoreTrack(track, query, tokens) {
  const title = normalizeText(track.title);
  const artist = normalizeText(track.artist);
  const album = normalizeText(track.album);
  if (!tokens.every((token) => track.searchText.includes(token))) return 0;
  let score = 10;
  if (title === query) score += 80;
  if (title.startsWith(query)) score += 45;
  if (artist.startsWith(query)) score += 25;
  if (album.startsWith(query)) score += 12;
  for (const token of tokens) {
    if (title.includes(token)) score += 8;
    if (artist.includes(token)) score += 5;
    if (album.includes(token)) score += 3;
  }
  return score;
}

function searchIndexedTracks(index, query, offset = 0, limit = 100) {
  const normalized = normalizeText(query).trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (!tokens.length || !index?.tracks?.length) {
    return { offset, limit, total: 0, items: [] };
  }
  const matches = index.tracks
    .map((track) => ({ track, score: scoreTrack(track, normalized, tokens) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title));
  return {
    offset,
    limit,
    total: matches.length,
    items: matches.slice(offset, offset + limit).map((result) => publicTrack(result.track)),
  };
}

async function buildLibraryIndex(session, serverId, preferredUri, sectionKey) {
  const index = getLibraryIndex(serverId, sectionKey);
  if (index.status === "indexing" && index.promise) return index.promise;

  index.status = "indexing";
  index.error = "";
  index.loaded = 0;
  index.total = 0;
  index.tracks = [];
  index.updatedAt = Date.now();

  index.promise = (async () => {
    try {
      let start = 0;
      let activeUri = preferredUri || "";
      for (;;) {
        const result = await plexServerAny(
          session,
          serverId,
          activeUri,
          `/library/sections/${encodeURIComponent(sectionKey)}/all`,
          {
            params: { type: "10" },
            headers: {
              "X-Plex-Container-Start": String(start),
              "X-Plex-Container-Size": String(INDEX_PAGE_SIZE),
            },
            timeoutMs: 15000,
          },
        );
        activeUri = result.server.uri;
        index.serverUri = activeUri;
        const page = mediaContainerItems(result.payload, "Metadata")
          .filter((item) => item.type === "track")
          .map(trackSummary);
        const total = Number(result.payload?.MediaContainer?.totalSize || 0);
        index.total = total || index.total || page.length;
        index.tracks.push(...page);
        index.loaded = index.tracks.length;
        index.updatedAt = Date.now();

        if (!page.length || page.length < INDEX_PAGE_SIZE) break;
        start += page.length;
        if (index.total && start >= index.total) break;
      }
      index.status = "ready";
      index.total = index.tracks.length;
      index.updatedAt = Date.now();
    } catch (error) {
      index.status = "error";
      index.error = error.message || "Index failed";
      index.updatedAt = Date.now();
      throw error;
    } finally {
      index.promise = null;
    }
    return index;
  })();

  return index.promise;
}

function startLibraryIndex(session, serverId, preferredUri, sectionKey) {
  const index = getLibraryIndex(serverId, sectionKey);
  if (index.status === "ready" || index.status === "indexing") return index;
  buildLibraryIndex(session, serverId, preferredUri, sectionKey).catch(() => {});
  return index;
}

function paginate(items, requestUrl, defaultLimit = 80) {
  const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
  const limit = Math.min(300, Math.max(1, Number(requestUrl.searchParams.get("limit") || defaultLimit)));
  return {
    offset,
    limit,
    total: items.length,
    items: items.slice(offset, offset + limit),
  };
}

function browseIndex(index, requestUrl) {
  const mode = requestUrl.searchParams.get("mode") || "recent";
  const artistFilter = requestUrl.searchParams.get("artist") || "";
  const albumFilter = requestUrl.searchParams.get("album") || "";
  let tracks = index.tracks || [];
  if (artistFilter) tracks = tracks.filter((track) => track.artist === artistFilter);
  if (albumFilter) tracks = tracks.filter((track) => track.album === albumFilter);

  if (mode === "artists") {
    const groups = new Map();
    for (const track of tracks) {
      const name = track.artist || "Unknown Artist";
      groups.set(name, (groups.get(name) || 0) + 1);
    }
    const items = [...groups.entries()]
      .map(([name, count]) => ({ type: "artist", name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { mode, ...paginate(items, requestUrl, 120) };
  }

  if (mode === "albums") {
    const groups = new Map();
    for (const track of tracks) {
      const key = `${track.artist}\u0000${track.album || "Unknown Album"}`;
      const existing = groups.get(key) || {
        type: "album",
        title: track.album || "Unknown Album",
        artist: track.artist || "Unknown Artist",
        year: track.year || "",
        count: 0,
      };
      existing.count += 1;
      if (!existing.year && track.year) existing.year = track.year;
      groups.set(key, existing);
    }
    const items = [...groups.values()]
      .sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    return { mode, ...paginate(items, requestUrl, 100) };
  }

  const sorted = [...tracks].sort((a, b) => {
    if (mode === "recent") return b.addedAt - a.addedAt || a.title.localeCompare(b.title);
    return a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || a.title.localeCompare(b.title);
  });
  return { mode, ...paginate(sorted.map(publicTrack), requestUrl, 100) };
}

function safeFilename(name) {
  return String(name || "track")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || "track";
}

function dispositionFilename(track, part) {
  const sourceName = part?.file ? part.file.split(/[\\/]/).pop() : "";
  const extension = extname(sourceName || part?.key || "");
  const base = safeFilename([track.grandparentTitle, track.title].filter(Boolean).join(" - "));
  return `${base}${extension && !base.endsWith(extension) ? extension : ""}`;
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = normalize(join(PUBLIC_ROOT, pathname));
  if (!filePath.startsWith(PUBLIC_ROOT) || !existsSync(filePath)) {
    sendError(res, 404, "Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

async function handleApi(req, res, session, requestUrl) {
  if (req.method === "GET" && requestUrl.pathname === "/api/session") {
    sendJson(res, 200, {
      loggedIn: Boolean(session.token),
      product: PRODUCT,
      clientIdentifier: CLIENT_IDENTIFIER,
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/start") {
    prunePendingPins();
    const pin = await plexTv("/api/v2/pins", {
      method: "POST",
      body: { strong: "true" },
    });
    pendingPins.set(String(pin.id), { id: String(pin.id), code: pin.code, createdAt: Date.now() });
    const authUrl = new URL("https://app.plex.tv/auth#");
    authUrl.hash = `?${new URLSearchParams({
      clientID: CLIENT_IDENTIFIER,
      code: pin.code,
      forwardUrl: `${requestUrl.origin}/`,
      "context[device][product]": PRODUCT,
    })}`;
    sendJson(res, 200, { id: String(pin.id), code: pin.code, authUrl: authUrl.toString() });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/auth/poll") {
    prunePendingPins();
    const pinId = requestUrl.searchParams.get("id");
    const pin = pendingPins.get(String(pinId || ""));
    if (!pin) {
      sendError(res, 410, "Sign-in PIN expired. Start sign-in again.");
      return;
    }
    const result = await plexTv(`/api/v2/pins/${encodeURIComponent(pin.id)}`, {
      params: {
        code: pin.code,
        "X-Plex-Client-Identifier": CLIENT_IDENTIFIER,
      },
    });
    if (result.authToken) {
      session.token = result.authToken;
      pendingPins.delete(pin.id);
    }
    sendJson(res, 200, { complete: Boolean(result.authToken) });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/auth/logout") {
    delete session.token;
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/servers") {
    const servers = await ownedServers(session);
    sendJson(res, 200, {
      servers: servers.map(({ accessToken, ...server }) => server),
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/libraries") {
    const result = await plexServerAny(
      session,
      requestUrl.searchParams.get("serverId"),
      requestUrl.searchParams.get("uri"),
      "/library/sections",
    );
    const libraries = mediaContainerItems(result.payload, "Directory")
      .filter(sectionIsMusic)
      .map((section) => ({
        key: String(section.key),
        title: section.title,
        type: section.type,
        agent: section.agent || "",
      }));
    sendJson(res, 200, {
      libraries,
      serverUri: result.server.uri,
      connection: {
        uri: result.connection.uri,
        local: result.connection.local,
        relay: result.connection.relay,
      },
      attempts: result.attempts,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/index/status") {
    const index = getLibraryIndex(
      requestUrl.searchParams.get("serverId"),
      requestUrl.searchParams.get("sectionKey"),
    );
    sendJson(res, 200, indexStatus(index));
    return;
  }

  if ((req.method === "GET" || req.method === "POST") && requestUrl.pathname === "/api/index/start") {
    const serverId = requestUrl.searchParams.get("serverId");
    const sectionKey = requestUrl.searchParams.get("sectionKey");
    if (!serverId || !sectionKey) {
      sendError(res, 400, "Missing server or library");
      return;
    }
    const index = startLibraryIndex(
      session,
      serverId,
      requestUrl.searchParams.get("uri"),
      sectionKey,
    );
    sendJson(res, 200, indexStatus(index));
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/browse") {
    const serverId = requestUrl.searchParams.get("serverId");
    const sectionKey = requestUrl.searchParams.get("sectionKey");
    if (!serverId || !sectionKey) {
      sendError(res, 400, "Missing server or library");
      return;
    }
    const index = startLibraryIndex(session, serverId, requestUrl.searchParams.get("uri"), sectionKey);
    if (!index.tracks.length) {
      sendJson(res, 200, {
        status: index.status,
        loaded: index.loaded,
        total: index.total,
        mode: requestUrl.searchParams.get("mode") || "recent",
        offset: 0,
        limit: 0,
        totalItems: 0,
        items: [],
      });
      return;
    }
    const browse = browseIndex(index, requestUrl);
    sendJson(res, 200, {
      status: index.status,
      loaded: index.loaded,
      total: index.total,
      serverUri: index.serverUri,
      ...browse,
      totalItems: browse.total,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/search") {
    const query = requestUrl.searchParams.get("q")?.trim() || "";
    if (query.length < 2) {
      sendJson(res, 200, { tracks: [] });
      return;
    }
    const sectionKey = requestUrl.searchParams.get("sectionKey");
    if (!sectionKey) {
      sendError(res, 400, "Missing music library");
      return;
    }
    const serverId = requestUrl.searchParams.get("serverId");
    const offset = Math.max(0, Number(requestUrl.searchParams.get("offset") || 0));
    const limit = Math.min(300, Math.max(1, Number(requestUrl.searchParams.get("limit") || 100)));
    const index = startLibraryIndex(session, serverId, requestUrl.searchParams.get("uri"), sectionKey);
    if (index.tracks.length) {
      const search = searchIndexedTracks(index, query, offset, limit);
      sendJson(res, 200, {
        tracks: search.items,
        offset: search.offset,
        limit: search.limit,
        totalItems: search.total,
        source: index.status === "ready" ? "index" : "partial-index",
        index: indexStatus(index),
        serverUri: index.serverUri || requestUrl.searchParams.get("uri") || "",
      });
      return;
    }

    let result;
    try {
      result = await plexServerAny(
        session,
        requestUrl.searchParams.get("serverId"),
        requestUrl.searchParams.get("uri"),
        `/library/sections/${encodeURIComponent(sectionKey)}/search`,
        {
          params: { type: "10", query },
          headers: {
            "X-Plex-Container-Start": String(offset),
            "X-Plex-Container-Size": String(limit),
          },
        },
      );
    } catch {
      result = await plexServerAny(
        session,
        requestUrl.searchParams.get("serverId"),
        requestUrl.searchParams.get("uri"),
        `/library/sections/${encodeURIComponent(sectionKey)}/all`,
        {
          params: { type: "10", title: query },
          headers: {
            "X-Plex-Container-Start": String(offset),
            "X-Plex-Container-Size": String(limit),
          },
        },
      );
    }

    const tracks = mediaContainerItems(result.payload, "Metadata")
      .filter((item) => item.type === "track")
      .map(trackSummary)
      .map(publicTrack);
    sendJson(res, 200, {
      tracks,
      offset,
      limit,
      totalItems: Number(result.payload?.MediaContainer?.totalSize || tracks.length),
      source: "plex",
      serverUri: result.server.uri,
      connection: {
        uri: result.connection.uri,
        local: result.connection.local,
        relay: result.connection.relay,
      },
      attempts: result.attempts,
    });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/art") {
    const path = requestUrl.searchParams.get("path");
    if (!path || !path.startsWith("/")) {
      sendError(res, 400, "Missing artwork path");
      return;
    }
    const result = await plexBinaryAny(
      session,
      requestUrl.searchParams.get("serverId"),
      requestUrl.searchParams.get("uri"),
      path,
    );
    res.writeHead(200, {
      "Content-Type": result.response.headers.get("content-type") || "image/jpeg",
      "Cache-Control": "private, max-age=600",
    });
    Readable.fromWeb(result.response.body).pipe(res);
    return;
  }

  sendError(res, 404, "Unknown API route");
}

async function handleDownload(req, res, session, requestUrl) {
  const metadata = await plexServerAny(
    session,
    requestUrl.searchParams.get("serverId"),
    requestUrl.searchParams.get("uri"),
    `/library/metadata/${encodeURIComponent(requestUrl.searchParams.get("ratingKey") || "")}`,
  );
  const ratingKey = requestUrl.searchParams.get("ratingKey");
  const partIndex = Number(requestUrl.searchParams.get("partIndex") || 0);
  if (!ratingKey) {
    sendError(res, 400, "Missing track rating key");
    return;
  }

  const track = firstItem(metadata.payload);
  const part = firstPart(track, Number.isFinite(partIndex) ? partIndex : 0);
  if (!track || !part?.key) {
    sendError(res, 404, "Track file not found");
    return;
  }

  const headers = { Accept: "*/*" };
  if (req.headers.range) headers.Range = req.headers.range;

  const result = await plexBinaryAny(
    session,
    metadata.server.id,
    metadata.server.uri,
    part.key,
    { headers, timeoutMs: 12000 },
  );

  const filename = dispositionFilename(track, part);
  const responseHeaders = {
    "Content-Type": result.response.headers.get("content-type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Accept-Ranges": result.response.headers.get("accept-ranges") || "bytes",
    "Cache-Control": "private, no-store",
  };

  for (const header of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = result.response.headers.get(header);
    if (value) responseHeaders[header.replace(/\b\w/g, (char) => char.toUpperCase())] = value;
  }

  res.writeHead(result.response.status, responseHeaders);
  Readable.fromWeb(result.response.body).pipe(res);
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const session = getSession(req, res);
  try {
    if (requestUrl.pathname.startsWith("/api/")) {
      await handleApi(req, res, session, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/download") {
      await handleDownload(req, res, session, requestUrl);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    sendError(res, 405, "Method not allowed");
  } catch (error) {
    const status = Number(error.status || 500);
    if (status >= 500) console.error(error);
    sendError(res, status, error.message || "Unexpected server error", error.payload);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`${PRODUCT} running at http://127.0.0.1:${PORT}`);
});
