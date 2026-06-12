const CACHE = 'fleetdesk-v4';
const PRECACHE = [
  '/fleet-tracker/',
  '/fleet-tracker/index.html',
  '/fleet-tracker/driver.html',
  '/fleet-tracker/manifest.json',
  '/fleet-tracker/hero.jpg'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests for same-origin or precached assets
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Let Supabase API and storage calls go straight to network
  if (url.hostname.includes('supabase.co') || url.hostname.includes('workers.dev')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      const network = fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
      // Serve cache first, fall back to network; if both fail, serve cached
      return cached || network;
    })
  );
});
