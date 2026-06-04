// Minimal service worker — enables PWA install and offline app-shell loading.
// It caches the built app files so the app opens even with no signal. It does
// NOT try to cache API calls or queue writes — that's handled in-app (retry
// queue) so the logic stays visible and debuggable.

const CACHE = "truck-stock-shell-v1";

// On install, pre-cache the shell. Vite hashes asset filenames, so we cache
// at runtime (below) rather than listing exact files here.
self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Never cache API calls — those must hit the network (and the app handles
  // failures with its own retry queue).
  if (url.pathname.startsWith("/api/") || url.hostname.includes("workers.dev")) {
    return; // let it go to network normally
  }

  // App shell: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
