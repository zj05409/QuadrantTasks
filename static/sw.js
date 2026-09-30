/* Offline-capable shell: network-first for app files, falling back to cache.
   API calls (any origin) are never touched. */
const CACHE = "quadrant-shell-v6";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return; // cross-origin sync server
  if (url.pathname.includes("/api/")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          // Strip cache-busting params (?_refresh=...) so the shell entry is reused.
          const key = req.mode === "navigate" ? "./index.html" : req;
          caches.open(CACHE).then((c) => c.put(key, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req, { ignoreSearch: req.mode === "navigate" })
          .then((r) => r || caches.match("./index.html"))
      )
  );
});
