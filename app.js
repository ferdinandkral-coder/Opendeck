// ---------------------------------------------------------------
// OpenDeck — free ADS-B + ACARS viewer (PWA)
// Data sources:
//   Positions: https://api.adsb.lol  (public, no key required)
//   ACARS:     https://api.airframes.io/v1  (public endpoints work
//              without a key, but a free feeder key raises the
//              rate limit — see docs.airframes.io/api)
// ---------------------------------------------------------------

const DEFAULT_CENTER = [48.2082, 16.3738]; // Vienna, fallback only
const STORE_KEY = "opendeck.settings.v1";

// Any uncaught error becomes visible instead of silently breaking taps —
// makes future bugs diagnosable from the phone itself.
let bannerTimer = null;
function showBanner(msg) {
  let el = document.getElementById("error-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "error-banner";
    el.style.cssText =
      "position:fixed;left:10px;right:10px;top:56px;z-index:900;" +
      "background:#3a1418;border:1px solid #7a2530;color:#ffb3ba;" +
      "font:12px var(--mono, monospace);padding:8px 10px;border-radius:6px;";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => (el.hidden = true), 8000);
}
window.addEventListener("error", (e) => showBanner(`Fehler: ${e.message}`));
window.addEventListener("unhandledrejection", (e) =>
  showBanner(`Fehler: ${e.reason?.message || e.reason}`)
);

// ---------------- debug log ----------------
// Ring buffer of the last N request attempts — which source, which wrapper,
// how long it took, and what happened. Viewable via the 🐞 button.
const DEBUG_LOG = [];
const DEBUG_LOG_MAX = 40;
function logDebug(entry) {
  DEBUG_LOG.unshift({ time: Date.now(), ...entry });
  if (DEBUG_LOG.length > DEBUG_LOG_MAX) DEBUG_LOG.length = DEBUG_LOG_MAX;
  if (!document.getElementById("debug-sheet").hidden) renderDebugLog();
}

// Some public aviation APIs don't send CORS headers for arbitrary browser
// origins (they're built for server-to-server use). Try the user's own
// proxy first (if configured — see cloudflare-worker.js), then direct,
// then public CORS proxies as a last resort (these are unreliable and
// tend to rate-limit or block after a while).
function corsWrappers() {
  const wrappers = [];
  if (state.proxyUrl) {
    wrappers.push({
      name: "Eigener Proxy",
      wrap: (u) => `${state.proxyUrl.replace(/\/$/, "")}/?url=${encodeURIComponent(u)}`,
    });
  }
  if (state.proxyUrl2) {
    wrappers.push({
      name: "Zweiter Proxy",
      wrap: (u) => `${state.proxyUrl2.replace(/\/$/, "")}/?url=${encodeURIComponent(u)}`,
    });
  }
  wrappers.push({ name: "Direkt", wrap: (u) => u });
  wrappers.push({
    name: "corsproxy.io",
    wrap: (u) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  });
  return wrappers;
}

async function fetchJson(url, opts = {}, sourceName = url) {
  let lastErr;
  const wrappers = corsWrappers();
  const startIdx = stickyWrapper.get(sourceName) ?? 0;
  const keys = [...wrappers.keys()];
  const order = keys.slice(startIdx % keys.length).concat(keys.slice(0, startIdx % keys.length));
  for (const idx of order) {
    const { name, wrap } = wrappers[idx];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const t0 = performance.now();
    try {
      const res = await fetch(wrap(url), { ...opts, signal: controller.signal });
      const ms = Math.round(performance.now() - t0);
      if (res.status === 429) throw Object.assign(new Error("HTTP 429"), { rateLimited: true, ms });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { ms });
      const json = await res.json();
      stickyWrapper.set(sourceName, idx);
      logDebug({ source: sourceName, wrapper: name, ok: true, ms, detail: `HTTP ${res.status}` });
      return json;
    } catch (err) {
      const ms = err.ms ?? Math.round(performance.now() - t0);
      const isAbort = err.name === "AbortError";
      const detail = isAbort ? "Zeitüberschreitung (7s)" : err.message;
      logDebug({ source: sourceName, wrapper: name, ok: false, ms, detail });
      lastErr = isAbort ? new Error("Zeitüberschreitung (7s)") : err;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr;
}

const state = {
  radiusNm: 100,
  airframesKey: "",
  proxyUrl: "",
  proxyUrl2: "",
  openskyAuth: "", // "user:pass"
  aircraft: new Map(),   // hex -> {marker, data}
  selectedHex: null,
  center: DEFAULT_CENTER,
};

loadSettings();

// ---------------- map ----------------
const map = L.map("map", {
  zoomControl: false,
  attributionControl: true,
}).setView(state.center, 8);

// Standard OSM tiles — no API key required. Darkened via CSS filter
// on .leaflet-tile-pane in style.css to match the EFIS theme.
L.tileLayer(
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  {
    attribution: '&copy; OpenStreetMap contributors — ADS-B: adsb.lol — ACARS: airframes.io',
    subdomains: "abc",
    maxZoom: 19,
  }
).addTo(map);

L.control.attribution({ prefix: false }).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);

navigator.geolocation?.getCurrentPosition(
  (pos) => {
    state.center = [pos.coords.latitude, pos.coords.longitude];
    map.setView(state.center, 9);
  },
  () => {}, // keep fallback center silently
  { timeout: 6000 }
);

document.getElementById("btn-locate").addEventListener("click", () => {
  navigator.geolocation?.getCurrentPosition((pos) => {
    map.setView([pos.coords.latitude, pos.coords.longitude], 10);
  });
});

// ---------------- aircraft glyph ----------------
function planeIcon(track, selected) {
  const color = selected ? "var(--route)" : "var(--own)";
  return L.divIcon({
    className: "",
    html: `<svg class="ac-icon${selected ? " ac-icon--selected" : ""}"
             width="22" height="22" viewBox="0 0 24 24"
             style="transform:rotate(${track || 0}deg)">
             <path fill="currentColor"
               d="M12 2 L15 11 L22 14 L15 15.5 L14 22 L12 19 L10 22 L9 15.5 L2 14 L9 11 Z"/>
           </svg>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function upsertAircraft(ac) {
  if (!ac.lat || !ac.lon) return;
  const hex = ac.hex;
  const label = ac.flight?.trim() || hex;
  const existing = state.aircraft.get(hex);
  const selected = hex === state.selectedHex;

  if (existing) {
    existing.marker.setLatLng([ac.lat, ac.lon]);
    existing.marker.setIcon(planeIcon(ac.track, selected));
    existing.data = ac;
  } else {
    const marker = L.marker([ac.lat, ac.lon], {
      icon: planeIcon(ac.track, selected),
    }).addTo(map);
    marker.on("click", () => selectAircraft(hex));
    marker.bindTooltip(label, {
      permanent: true,
      direction: "top",
      offset: [0, -10],
      className: "ac-icon__label",
    });
    state.aircraft.set(hex, { marker, data: ac });
  }
}

function selectAircraft(hex) {
  state.selectedHex = hex;
  const entry = state.aircraft.get(hex);
  if (!entry) return;
  const ac = entry.data;

  document.getElementById("db-callsign").textContent = ac.flight?.trim() || ac.hex;
  document.getElementById("db-type").textContent = ac.t || "—";
  document.getElementById("db-reg").textContent = ac.r || "—";
  document.getElementById("db-alt").textContent = ac.alt_baro ? `${ac.alt_baro} ft` : "—";
  document.getElementById("db-gs").textContent = ac.gs ? `${Math.round(ac.gs)} kt` : "—";
  document.getElementById("db-hdg").textContent = ac.track ? `${Math.round(ac.track)}°` : "—";
  document.getElementById("db-sqk").textContent = ac.squawk || "—";
  document.getElementById("datablock").hidden = false;

  // repaint icons so the selected one highlights
  for (const [h, e] of state.aircraft) {
    e.marker.setIcon(planeIcon(e.data.track, h === hex));
  }
}

document.getElementById("db-close").addEventListener("click", () => {
  document.getElementById("datablock").hidden = true;
  state.selectedHex = null;
  for (const [, e] of state.aircraft) e.marker.setIcon(planeIcon(e.data.track, false));
});

// stale-aircraft cleanup: drop markers not refreshed in 2 poll cycles
function pruneStale(seenHexes) {
  for (const [hex, entry] of state.aircraft) {
    if (!seenHexes.has(hex)) {
      map.removeLayer(entry.marker);
      state.aircraft.delete(hex);
    }
  }
}

// ---------------- ADS-B polling ----------------
// Three independent sources with different query schemas — if one is
// blocked/rate-limited/down, the next takes over. adsb.lol/adsb.fi use a
// point+radius query; OpenSky (an academic project, well suited to exactly
// this kind of hobby use) uses a bounding box, which maps even more
// naturally onto "load what's in the visible map area".
const ADSB_SOURCES = [
  { name: "adsb.lol", kind: "point", base: "https://api.adsb.lol/v2" },
  { name: "adsb.fi", kind: "point", base: "https://opendata.adsb.fi/api/v2" },
  { name: "opensky", kind: "bbox", base: "https://opensky-network.org/api/states/all" },
];
// Remember which wrapper (direct / proxy A / proxy B) last worked for each
// source, and try that one first next time — cuts needless retries once we
// know a path works.
const stickyWrapper = new Map();

function haversineNm(a, b) {
  const R = 3440.065; // earth radius in nautical miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(h));
}

// Radius covering the current viewport (center to corner), clamped to a
// sane range and capped by the user's "Suchradius" setting in ⚙.
function viewportRadiusNm() {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const corner = bounds.getNorthEast();
  const raw = haversineNm([center.lat, center.lng], [corner.lat, corner.lng]);
  return Math.min(Math.max(Math.round(raw), 5), state.radiusNm);
}

function buildAdsbUrl(src) {
  if (src.kind === "bbox") {
    const b = map.getBounds();
    return `${src.base}?lamin=${b.getSouth()}&lomin=${b.getWest()}&lamax=${b.getNorth()}&lomax=${b.getEast()}`;
  }
  const center = map.getCenter();
  const radius = viewportRadiusNm();
  return `${src.base}/lat/${center.lat}/lon/${center.lng}/dist/${radius}`;
}

// Normalize each source's own response shape into the common
// {hex, lat, lon, track, flight, alt_baro, gs, squawk, t, r} shape upsertAircraft expects.
function normalizeAircraft(src, data) {
  if (src.kind === "bbox") {
    // OpenSky: data.states is an array of fixed-position arrays, see
    // https://openskynetwork.github.io/opensky-api/rest.html#response
    const states = data.states || [];
    return states
      .map((s) => ({
        hex: s[0],
        flight: (s[1] || "").trim(),
        lon: s[5],
        lat: s[6],
        alt_baro: s[7] != null ? Math.round(s[7] * 3.28084) : s[13] != null ? Math.round(s[13] * 3.28084) : null,
        gs: s[9] != null ? Math.round(s[9] * 1.94384) : null,
        track: s[10],
        squawk: s[14] || null,
        t: null,
        r: null,
      }))
      .filter((ac) => ac.lat != null && ac.lon != null);
  }
  return data.ac || [];
}

async function pollAircraft() {
  let lastErr = null;

  for (const src of ADSB_SOURCES) {
    const url = buildAdsbUrl(src);
    const headers =
      src.name === "opensky" && state.openskyAuth
        ? { Authorization: `Basic ${btoa(state.openskyAuth)}` }
        : {};
    try {
      const data = await fetchJson(url, { headers }, src.name);
      const list = normalizeAircraft(src, data);
      const seen = new Set();
      for (const ac of list) {
        if (!ac.hex) continue;
        seen.add(ac.hex);
        upsertAircraft(ac);
      }
      pruneStale(seen);
      document.getElementById("stat-count").textContent = list.length;
      document.getElementById("stat-source").textContent = src.name;
      pollBackoff = POLL_BASE_MS; // reset backoff on success
      return; // success — done for this cycle
    } catch (err) {
      lastErr = err;
      console.warn(`${src.name} poll failed`, err);
    }
  }
  // every source failed — back off so we don't hammer dead endpoints
  document.getElementById("stat-source").textContent = "offline";
  pollBackoff = Math.min(pollBackoff * 2, POLL_MAX_MS);
  showBanner(`Keine ADS-B-Quelle erreichbar (${lastErr?.message || "unbekannter Fehler"}). Details: 🐞 Debug-Log.`);
}

// ---------------- ACARS readability ----------------
// Best-effort translation of common ARINC-620 label codes. Not exhaustive —
// many labels are airline/avionics-specific — unknown codes just show raw.
const ACARS_LABELS = {
  H1: "Freitext",
  "5Z": "OOOI-Report",
  "80": "OUT – Push-back",
  "81": "OFF – Abheben",
  "82": "ON – Aufsetzen",
  "83": "IN – Ankunft am Gate",
  "10": "Positions-/Fortschrittsbericht",
  "16": "Wettermeldung",
  SA: "Systemadresse",
  Q0: "Quittierung",
};
function labelName(label) {
  return ACARS_LABELS[label] || null;
}
function cleanAcarsText(raw) {
  return String(raw || "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // strip control chars
    .replace(/\s+/g, " ")
    .trim();
}

// Group messages by aircraft instead of dumping a flat chronological list —
// one card per aircraft, latest message up front, older ones tucked away.
const expandedAcarsGroups = new Set();
function renderAcarsGroups(messages) {
  const groups = new Map();
  for (const m of messages) {
    const key = m.tail || m.flight || m.callsign || m.icao || "—";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const ts = (m) => m.timestamp || m.time || 0;
  for (const arr of groups.values()) arr.sort((a, b) => ts(b) - ts(a));
  const sortedKeys = [...groups.keys()].sort((a, b) => ts(groups.get(b)[0]) - ts(groups.get(a)[0]));

  return sortedKeys
    .map((key) => {
      const msgs = groups.get(key);
      const latest = msgs[0];
      const friendly = labelName(latest.label);
      const text = cleanAcarsText(latest.text || latest.message) || "(kein Text)";
      const extra = msgs.length - 1;
      const open = expandedAcarsGroups.has(key);
      const history = msgs
        .slice(1)
        .map((m) => {
          const f = labelName(m.label);
          return `<div class="acars-group__hist">
            <span class="acars-group__hist-label">${escapeHtml(m.label || "")}${f ? " · " + escapeHtml(f) : ""}</span>
            <div>${escapeHtml(cleanAcarsText(m.text || m.message) || "(kein Text)")}</div>
          </div>`;
        })
        .join("");
      return `
        <li class="scratchpad__msg acars-group" data-key="${escapeHtml(key)}">
          <button class="acars-group__head" type="button">
            <span class="acars-group__ac">${escapeHtml(key)}</span>
            <span class="acars-group__label">${escapeHtml(friendly || latest.label || "—")}</span>
            ${extra > 0 ? `<span class="acars-group__count">+${extra}</span>` : ""}
          </button>
          <div class="acars-group__latest">${escapeHtml(text)}</div>
          ${extra > 0 ? `<div class="acars-group__history" ${open ? "" : "hidden"}>${history}</div>` : ""}
        </li>`;
    })
    .join("");
}

// ---------------- ACARS polling ----------------
async function pollAcars() {
  const listEl = document.getElementById("acars-list");
  const emptyEl = document.getElementById("acars-empty");
  const countEl = document.getElementById("acars-count");

  const center = map.getCenter();
  const [lat, lon] = [center.lat, center.lng];
  const radius = viewportRadiusNm();
  // NOTE: adjust query params against the OpenAPI spec at
  // docs.airframes.io/api-reference if the schema has moved on —
  // this targets /v1/messages filtered to a radius around the map center.
  // Public endpoints work anonymously (no key) at a lower rate limit;
  // a free feeder key just raises that limit — see docs.airframes.io/api.
  const url = `https://api.airframes.io/v1/messages?lat=${lat}&lon=${lon}&radius=${radius}&limit=30`;
  const headers = state.airframesKey
    ? { Authorization: `Bearer ${state.airframesKey}` }
    : {};
  try {
    const data = await fetchJson(url, { headers }, "airframes.io");
    const messages = data.data || data.messages || data || [];
    emptyEl.textContent = "Noch keine ACARS-Nachrichten im Umkreis eingetroffen.";
    emptyEl.hidden = messages.length > 0;
    countEl.textContent = messages.length;
    listEl.innerHTML = renderAcarsGroups(messages.slice(0, 30));
  } catch (err) {
    if (err?.rateLimited) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Rate-Limit erreicht — ohne Key ist das Kontingent knapp. Ein kostenloser Feeder-Key unter ⚙ hebt das Limit an.";
    }
    console.warn("airframes.io poll failed", err);
  }
}

// Expand/collapse a group's older messages — delegated so it survives re-renders.
document.getElementById("acars-list").addEventListener("click", (e) => {
  const head = e.target.closest(".acars-group__head");
  if (!head) return;
  const li = head.closest(".acars-group");
  const hist = li.querySelector(".acars-group__history");
  if (!hist) return;
  const willOpen = hist.hidden;
  hist.hidden = !willOpen;
  if (willOpen) expandedAcarsGroups.add(li.dataset.key);
  else expandedAcarsGroups.delete(li.dataset.key);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------- scratchpad drawer ----------------
const scratchpad = document.getElementById("scratchpad");
document.getElementById("scratchpad-handle").addEventListener("click", () => {
  const open = scratchpad.classList.toggle("scratchpad--open");
  document.getElementById("scratchpad-handle").setAttribute("aria-expanded", open);
});

// ---------------- debug sheet ----------------
const debugSheet = document.getElementById("debug-sheet");
function renderDebugLog() {
  const list = document.getElementById("debug-log-list");
  if (!DEBUG_LOG.length) {
    list.innerHTML = `<p class="sheet__hint" style="margin:0;">Noch keine Anfragen protokolliert.</p>`;
    return;
  }
  list.innerHTML = DEBUG_LOG.map((e) => {
    const t = new Date(e.time).toLocaleTimeString("de-AT", { hour12: false });
    const cls = e.ok ? "debug-log__row--ok" : "debug-log__row--fail";
    return `<div class="debug-log__row ${cls}">
      <span class="debug-log__time">${t}</span>
      <span class="debug-log__src">${escapeHtml(e.source)}</span>
      <span class="debug-log__wrap">${escapeHtml(e.wrapper)}</span>
      <span class="debug-log__ms">${e.ms}ms</span>
      <span class="debug-log__detail">${escapeHtml(e.detail)}</span>
    </div>`;
  }).join("");
}
function debugLogAsText() {
  return DEBUG_LOG.map((e) => {
    const t = new Date(e.time).toLocaleTimeString("de-AT", { hour12: false });
    return `${t} | ${e.source} | ${e.wrapper} | ${e.ms}ms | ${e.ok ? "OK" : "FEHLER"}: ${e.detail}`;
  }).join("\n");
}
document.getElementById("btn-debug").addEventListener("click", () => {
  renderDebugLog();
  debugSheet.hidden = false;
});
document.getElementById("debug-close").addEventListener("click", () => (debugSheet.hidden = true));
document.getElementById("debug-clear").addEventListener("click", () => {
  DEBUG_LOG.length = 0;
  renderDebugLog();
});
document.getElementById("debug-copy").addEventListener("click", async () => {
  const text = debugLogAsText() || "(leer)";
  try {
    await navigator.clipboard.writeText(text);
    showBanner("Log kopiert.");
  } catch {
    showBanner("Kopieren nicht möglich — Log manuell markieren.");
  }
});

// ---------------- settings sheet ----------------
const sheet = document.getElementById("settings-sheet");
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("input-proxy-url").value = state.proxyUrl;
  document.getElementById("input-proxy-url-2").value = state.proxyUrl2;
  document.getElementById("input-airframes-key").value = state.airframesKey;
  document.getElementById("input-opensky-auth").value = state.openskyAuth;
  document.getElementById("input-radius").value = state.radiusNm;
  sheet.hidden = false;
});
document.getElementById("settings-close").addEventListener("click", () => (sheet.hidden = true));
document.getElementById("settings-save").addEventListener("click", () => {
  state.proxyUrl = document.getElementById("input-proxy-url").value.trim();
  state.proxyUrl2 = document.getElementById("input-proxy-url-2").value.trim();
  state.airframesKey = document.getElementById("input-airframes-key").value.trim();
  state.openskyAuth = document.getElementById("input-opensky-auth").value.trim();
  state.radiusNm = Number(document.getElementById("input-radius").value) || 100;
  stickyWrapper.clear(); // proxy config changed — re-probe from scratch
  saveSettings();
  sheet.hidden = true;
  pollAircraft();
  pollAcars();
});

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.proxyUrl = saved.proxyUrl || "";
    state.proxyUrl2 = saved.proxyUrl2 || "";
    state.airframesKey = saved.airframesKey || "";
    state.openskyAuth = saved.openskyAuth || "";
    state.radiusNm = saved.radiusNm || 100;
  } catch (_) {}
}
function saveSettings() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({
      proxyUrl: state.proxyUrl,
      proxyUrl2: state.proxyUrl2,
      airframesKey: state.airframesKey,
      openskyAuth: state.openskyAuth,
      radiusNm: state.radiusNm,
    })
  );
}

// ---------------- polling loop ----------------
// Adaptive interval: on repeated failures, back off (up to 60s) so we don't
// hammer dead/rate-limited endpoints; a success resets it back to base.
const POLL_BASE_MS = 12000;
const POLL_MAX_MS = 90000;
let pollBackoff = POLL_BASE_MS;

function scheduleAircraftPoll() {
  pollAircraft().finally(() => setTimeout(scheduleAircraftPoll, pollBackoff));
}
scheduleAircraftPoll();
pollAcars();
setInterval(pollAcars, 15000);

// Refetch on pan/zoom, debounced so a drag gesture doesn't spam requests.
let moveDebounce = null;
map.on("moveend", () => {
  clearTimeout(moveDebounce);
  moveDebounce = setTimeout(pollAircraft, 800);
});

// ---------------- service worker ----------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
  // When a new SW version takes over (see CACHE bump in sw.js), reload once
  // so the page picks up the fresh shell instead of running stale JS/CSS.
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
}
