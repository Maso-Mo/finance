/**
 * Service Worker Finance (étape 12) — Web Push.
 *
 * Responsabilités UNIQUEMENT :
 *  - recevoir l'événement `push` et afficher une notification système ;
 *  - gérer `notificationclick` (ouvrir/focaliser la bonne page).
 *
 * AUCUNE logique financière ici. Le payload affiché ne contient JAMAIS :
 *  - de jeton JWT / refresh token / secret ;
 *  - de donnée permettant d'effectuer une action financière.
 *
 * Le clic d'une notification ne déclenche JAMAIS de POST/PATCH/DELETE : il
 * ouvre simplement la route associée dans l'application.
 */
self.addEventListener('push', (event) => {
  let payload = {};
  try {
    const data = event.data ? event.data.json() : null;
    payload = data && typeof data === 'object' ? data : {};
  } catch (error) {
    payload = {};
  }

  const title = typeof payload.title === 'string' ? payload.title : 'Finance';
  const body =
    typeof payload.body === 'string' && payload.body ? payload.body : '';
  const route =
    typeof payload.route === 'string' && payload.route.startsWith('/')
      ? payload.route
      : '/notifications';

  const options = {
    body,
    data: { route },
    tag: `finance-${route}`,
    renotify: false,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const route =
    event.notification.data &&
    typeof event.notification.data.route === 'string'
      ? event.notification.data.route
      : '/notifications';
  const target = new URL(route, self.location.origin);

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      for (const client of all) {
        if ('focus' in client && typeof client.focus === 'function') {
          if (typeof client.navigate === 'function') {
            try {
              await client.navigate(target);
            } catch (error) {
              // Client déjà sur une autre URL interne : on le focalise tel quel.
            }
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(target);
      }
      return undefined;
    })(),
  );
});

// Versioned app shell only. Financial responses and auth are never cached.
const SHELL_CACHE = 'finance-shell-__BUILD_ID__';
const SHELL_ASSETS = /* __SHELL_ASSETS__ */ [];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('finance-shell-') && key !== SHELL_CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(async response => response.status >= 500 ? (await caches.match('/index.html', { cacheName: SHELL_CACHE })) || response : response).catch(async () => (await caches.match('/index.html', { cacheName: SHELL_CACHE })) || Response.error()));
  } else if (SHELL_ASSETS.includes(url.pathname)) {
    // Versioned same-origin static files are identical across Origin headers.
    // Vite's Vary: Origin must not make crossorigin module requests miss the precache.
    event.respondWith(caches.match(event.request, { cacheName: SHELL_CACHE, ignoreVary: true }).then(cached => cached || fetch(event.request)));
  }
});
