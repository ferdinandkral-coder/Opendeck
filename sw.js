const CACHE = "opendeck-shell-v16"; // bump this string on every shell-file change
const SHELL = ["./", "index.html", "style.css", "app.js", "manifest.json", "icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting(); // activate the new SW immediately, don't wait for old tabs to close
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim(); // take control of already-open tabs right away
});

// Shell files: cache-first. Live data (adsb.lol / airframes.io): always network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isLiveData = url.hostname.includes("adsb.lol") || url.hostname.includes("airframes.io");
  if (isLiveData) return; // let it hit the network untouched

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
