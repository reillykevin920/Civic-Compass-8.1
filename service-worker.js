
// NOTE: GitHub Pages PWAs fail "install" if cache.addAll includes any missing file.
// This service worker builds the offline cache *only* from actual manifests shipped
// with the site, ensuring first-load-online results in full offline search/reader.
// Bump cache name every pack to force a clean upgrade.
const CACHE_NAME = "corpa-compass-pack-003";

const CORE = [
  "./",
  "./index.html",
  "./viewer.html",
  "./manifest.webmanifest",
  "./assets/styles.css",
  "./assets/app.js",

  // App icons
  "./assets/icons/apple-touch-icon.png",
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png",
  "./assets/icons/favicon16.ico",
  "./assets/icons/favicon32.ico",
  "./assets/icons/favicon-48.ico",

  // Base data files (dataset-driven). These are expected to exist in every build.
  "./data/categories.json",
  "./data/concepts.json",

];

async function safeJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function safeAdd(assets, url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) assets.add(url);
  } catch (_) {}
}

async function buildAssetList() {
  const assets = new Set(CORE);

  // Optional files: only cache if they exist
  await Promise.all([
    safeAdd(assets, "./data/dataset_manifest.json"),
  ]);

  // Determine corpora manifests from dataset manifest when present; otherwise fall back to Boulder defaults.
  const ds = await safeJson("./data/dataset_manifest.json");
  const corpusDefs = (ds && Array.isArray(ds.corpora) && ds.corpora.length)
    ? ds.corpora
    : [];

  for (const c of corpusDefs) {
    const manifestUrl = c.manifest ? String(c.manifest) : (`./data/${String(c.folder || "").trim() || ""}_manifest.json`);
    await safeAdd(assets, manifestUrl);

    const payload = await safeJson(manifestUrl);
    if (!payload) continue;

    // Standard: payload.chapters[]
    if (Array.isArray(payload.chapters)) {
      for (const ch of payload.chapters) {
        if (ch && ch.file) assets.add(`./data/${String(c.folder)}/${String(ch.file).split('/').pop()}`);
      }
      continue;
    }

    // Boulder legacy: brc_manifest.json uses titles[]
    if (Array.isArray(payload.titles)) {
      for (const t of payload.titles) {
        if (t && t.file) assets.add(`./data/${String(c.folder)}/${String(t.file).split('/').pop()}`);
      }
      continue;
    }
  }

  // Technical drawings PDFs are intentionally NOT pre-cached.
  // Drawings are optional per-dataset; prefetching would generate 404 noise for datasets without drawings.

  return [...assets];
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    const assets = await buildAssetList();
    await cache.addAll(assets);
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME) ? null : caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  event.respondWith((async () => {
    const req = event.request;
    const url = new URL(req.url);

    // Always bypass cache for the service worker itself
    if (url.pathname.endsWith("/service-worker.js")) {
      return fetch(req, { cache: "no-store" });
    }

    // Network-first for app assets + JSON so local dev + rebuilds don't get stuck on stale caches.
    const isAppAsset =
      url.pathname.endsWith("/assets/app.js") ||
      url.pathname.endsWith("/assets/styles.css") ||
      url.pathname.endsWith("/index.html") ||
      url.pathname.endsWith("/viewer.html");

    const isJson = url.pathname.endsWith(".json") || req.headers.get("accept")?.includes("application/json");

    if (isAppAsset || isJson) {
      try {
        const fresh = await fetch(req, { cache: "no-store" });
        // If we have an active cache, update it opportunistically
        try {
          if (req.method === "GET" && fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          if (req.method === "GET") { await cache.put(req, fresh.clone()); }
        }
        } catch (_) {}
        return fresh;
      } catch (e) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        throw e;
      }
    }

    // Cache-first for everything else (icons, etc.)
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      return res;
    } catch (e) {
      if (req.mode === "navigate") {
        const fallback = await caches.match("./index.html");
        if (fallback) return fallback;
      }
      throw e;
    }
  })());
});

