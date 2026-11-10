const CACHE = 'layerpeel-offline-11';
const PREVIOUS_CACHE = 'layerpeel-offline-9';
const shell = ['style.css?v=10', 'styles.js', 'app.js?v=11', 'beatvision-generator.js?v=11', 'filter.js', 'filter-model.js', 'completion.js', 'completion-worker.js', 'engine.js', 'zip.js', 'sw.js',
  'icon.svg', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest', 'vision/litert.js', 'models/labels.js'];
const models = ['models/portrait.tflite', 'models/objects.tflite', 'models/touch.tflite', 'models/anchors.bin',
  'vision/wasm/litert_wasm_internal.js', 'vision/wasm/litert_wasm_internal.wasm',
  'vision/wasm/litert_wasm_compat_internal.js', 'vision/wasm/litert_wasm_compat_internal.wasm',
  'reconstruction/ort.wasm.min.mjs', 'reconstruction/ort-wasm-simd-threaded.mjs',
  'reconstruction/ort-wasm-simd-threaded.wasm', 'reconstruction/lama-0', 'reconstruction/lama-1'];
const url = path => new URL(path, self.registration.scope).href;
const assets = [...shell, ...models, 'index.html', './'].map(url);
const legacyAssets = new Set([...shell, ...models, 'app.js?v=9', 'style.css?v=9'].map(url));
const reusable = new Set(models.map(url));
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data !== 'download') return;
  const port = event.ports[0];
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      const previous = await caches.has(PREVIOUS_CACHE) ? await caches.open(PREVIOUS_CACHE) : null;
      for (const [index, asset] of assets.entries()) {
        if (!(await cache.match(asset))) {
          const cached = reusable.has(asset) ? await previous?.match(asset) : null;
          const response = cached || await fetch(asset, {cache: 'reload'});
          if (!response.ok || response.redirected) throw new Error('Could not download ' + new URL(asset).pathname);
          await cache.put(asset, response);
        }
        port.postMessage({done: index + 1, total: assets.length});
      }
      for (const key of await caches.keys()) {
        if (key !== CACHE && key.startsWith('layerpeel-offline-')) await caches.delete(key);
      }
      port.postMessage({ready: true});
    } catch (error) {
      port.postMessage({error: error.message});
    }
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const path = event.request.url;
  if (event.request.mode === 'navigate' && path.startsWith(self.registration.scope)) {
    event.respondWith(fetch(event.request).catch(async () =>
      (await caches.match(self.registration.scope, {cacheName: CACHE})) ||
      (await caches.match(self.registration.scope, {cacheName: PREVIOUS_CACHE})) ||
      Response.error()
    ));
  } else if (assets.includes(path) || legacyAssets.has(path)) {
    event.respondWith((async () =>
      (await caches.match(path, {cacheName: CACHE})) ||
      await fetch(event.request).catch(async error => {
        const old = legacyAssets.has(path) && await caches.match(path, {cacheName: PREVIOUS_CACHE});
        if (old) return old;
        throw error;
      })
    )());
  }
});
