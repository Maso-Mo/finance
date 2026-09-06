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
