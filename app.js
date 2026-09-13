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

const state = {
  radiusNm: 100,
  airframesKey: "",
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
// Two mirrors with an identical URL schema — if one is unreachable
// from the browser (CORS, downtime, ...) the other takes over.
const ADSB_SOURCES = [
  { name: "adsb.lol", base: "https://api.adsb.lol/v2" },
  { name: "adsb.fi", base: "https://opendata.adsb.fi/api/v2" },
];

async function pollAircraft() {
  const [lat, lon] = state.center;
  let lastErr = null;

  for (const src of ADSB_SOURCES) {
    const url = `${src.base}/lat/${lat}/lon/${lon}/dist/${state.radiusNm}`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data.ac || [];
      const seen = new Set();
      for (const ac of list) {
        if (!ac.hex) continue;
        seen.add(ac.hex);
        upsertAircraft(ac);
      }
      pruneStale(seen);
      document.getElementById("stat-count").textContent = list.length;
      document.getElementById("stat-source").textContent = src.name;
      return; // success — done for this cycle
    } catch (err) {
      lastErr = err;
      console.warn(`${src.name} poll failed`, err);
    }
  }
  // every source failed
  document.getElementById("stat-source").textContent = "offline";
  showBanner(`Keine ADS-B-Quelle erreichbar (${lastErr?.message || "unbekannter Fehler"}).`);
}

// ---------------- ACARS polling ----------------
async function pollAcars() {
  const listEl = document.getElementById("acars-list");
  const emptyEl = document.getElementById("acars-empty");
  const countEl = document.getElementById("acars-count");

  const [lat, lon] = state.center;
  // NOTE: adjust query params against the OpenAPI spec at
  // docs.airframes.io/api-reference if the schema has moved on —
  // this targets /v1/messages filtered to a radius around the map center.
  // Public endpoints work anonymously (no key) at a lower rate limit;
  // a free feeder key just raises that limit — see docs.airframes.io/api.
  const url = `https://api.airframes.io/v1/messages?lat=${lat}&lon=${lon}&radius=${state.radiusNm}&limit=30`;
  const headers = state.airframesKey
    ? { Authorization: `Bearer ${state.airframesKey}` }
    : {};
  try {
    const res = await fetch(url, { headers });
    if (res.status === 429) {
      emptyEl.hidden = false;
      emptyEl.textContent = "Rate-Limit erreicht — ohne Key ist das Kontingent knapp. Ein kostenloser Feeder-Key unter ⚙ hebt das Limit an.";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const messages = data.data || data.messages || data || [];
    emptyEl.textContent = "Noch keine ACARS-Nachrichten im Umkreis eingetroffen.";
    emptyEl.hidden = messages.length > 0;
    countEl.textContent = messages.length;
    listEl.innerHTML = messages
      .slice(0, 30)
      .map(
        (m) => `
        <li class="scratchpad__msg">
          <div class="scratchpad__msg-head">
            <span>${escapeHtml(m.flight || m.callsign || m.tail || "—")}</span>
            <span>${escapeHtml(m.label || "")}</span>
          </div>
          <div>${escapeHtml(m.text || m.message || "")}</div>
        </li>`
      )
      .join("");
  } catch (err) {
    console.warn("airframes.io poll failed", err);
  }
}

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

// ---------------- settings sheet ----------------
const sheet = document.getElementById("settings-sheet");
document.getElementById("btn-settings").addEventListener("click", () => {
  document.getElementById("input-airframes-key").value = state.airframesKey;
  document.getElementById("input-radius").value = state.radiusNm;
  sheet.hidden = false;
});
document.getElementById("settings-close").addEventListener("click", () => (sheet.hidden = true));
document.getElementById("settings-save").addEventListener("click", () => {
  state.airframesKey = document.getElementById("input-airframes-key").value.trim();
  state.radiusNm = Number(document.getElementById("input-radius").value) || 100;
  saveSettings();
  sheet.hidden = true;
  pollAcars();
});

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.airframesKey = saved.airframesKey || "";
    state.radiusNm = saved.radiusNm || 100;
  } catch (_) {}
}
function saveSettings() {
  localStorage.setItem(
    STORE_KEY,
    JSON.stringify({ airframesKey: state.airframesKey, radiusNm: state.radiusNm })
  );
}

// ---------------- polling loop ----------------
pollAircraft();
pollAcars();
setInterval(pollAircraft, 8000);
setInterval(pollAcars, 15000);
map.on("moveend", () => {
  const c = map.getCenter();
  state.center = [c.lat, c.lng];
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
