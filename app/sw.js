// Service worker: makes the app installable and lets it start without network.
// Network first for the app files, so that updates arrive on the next start;
// the cache is only the fallback. Requests to Gemini are not touched.

const CACHE = "fridge-oracle-v2";
const APP_FILES = [
  "./",
  "index.html",
  "style.css",
  "manifest.webmanifest",
  "js/main.js",
  "js/gemini.js",
  "js/memory.js",
  "js/photos.js",
  "js/planner.js",
  "js/session.js",
  "js/settings.js",
  "js/staples.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

// Caching is best effort: if the cache is unavailable, the worker must still install,
// because Chrome only offers "Install app" with an active service worker.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(APP_FILES))
      .catch((error) => console.warn("Pre-caching failed:", error)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .catch(() => {})
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches
          .open(CACHE)
          .then((cache) => cache.put(event.request, copy))
          .catch(() => {});
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
