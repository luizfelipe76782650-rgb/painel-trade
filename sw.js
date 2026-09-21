/**
 * Offline shell for the panel.
 *
 * Network first, always: a cached copy is only served when the request fails,
 * so an update lands the moment it is published instead of waiting for a cache
 * to expire. Market data is cross-origin and never touched here.
 *
 * The network attempt bypasses the browser's own HTTP cache. Without that, a
 * "network first" worker still hands back whatever the browser is holding —
 * GitHub Pages marks the HTML cacheable for ten minutes — and the panel looks
 * stuck on an old build long after the new one is live. The cost is one real
 * request per file; the alternative is an update nobody can see.
 */
const CACHE = "painel-v2";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) =>
  e.waitUntil(
    (async () => {
      const nomes = await caches.keys();
      await Promise.all(nomes.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  )
);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request, { cache: "no-store" })
      .then((res) => {
        const copia = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
        return res;
      })
      .catch(() =>
        caches.match(e.request).then((r) => r || caches.match("./index.html"))
      )
  );
});
