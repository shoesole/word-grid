// Offline support. Online, every file is fetched fresh (revalidated with the server,
// so unchanged files cost a tiny 304), so updates show up on the next launch. Offline,
// or if the network is too slow, the last saved copy is used.
// Bump VERSION (and APP_VERSION in app.js) whenever any file in public/ changes.
const VERSION = "wg-v6";
const FILES = [
  "./", "index.html", "styles.css", "app.js", "engine.js", "coach.js", "define.js", "words.txt",
  "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png", "egg.gif",
];
const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener("install", (e) => {
  // cache: "reload" skips the browser's HTTP cache so we never save a stale copy.
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const fresh = fetch(req, { cache: "no-cache" }).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([fresh, timeout]);
    if (res) return res;
  } catch {}
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || fresh;
}
