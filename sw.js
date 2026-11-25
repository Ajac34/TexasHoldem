/* 离线缓存：首次在线打开后，即可离线运行（iOS 主屏幕 App） */
const CACHE = 'thsim-v4';
const FILES = [
  './', 'index.html', 'manifest.json', 'css/style.css',
  'js/cards.js', 'js/equity.js', 'js/profiles.js', 'js/stats.js', 'js/engine.js', 'js/ai.js',
  'js/personas.js', 'js/career.js', 'js/game.js', 'js/gto.js', 'js/ui.js', 'js/table.js', 'js/lobby.js', 'js/review.js', 'js/net.js', 'js/api.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 网络优先（拿到新版本就更新缓存），断网时用缓存
self.addEventListener('fetch', (e) => {
  const p = new URL(e.request.url).pathname;
  if (e.request.method !== 'GET' || p.includes('/api/') || p.startsWith('/admin')) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
