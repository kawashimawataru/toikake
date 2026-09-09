// オフライン用。白浜はネットがあるが、岩場で電波が細っても画面が落ちないようにする。
// 記録そのものは IndexedDB にあるので、ここは表示するファイルを配るだけ。
const CACHE = 'toikake-v1';
const SHELL = ['./', './index.html', './app.js', './engine.js', './vad.js',
               './store.js', './missions.js', './manifest.webmanifest',
               './icon.svg', './icon-180.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // ネットがあれば新しいものを取り、無ければキャッシュを返す。
  e.respondWith(
    fetch(e.request)
      .then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
