// Service worker for Web Push only (push.js registers it): shows the notice the server sent (push.mjs) and opens
// its page when tapped. No caching: pages always come from the server.
// The type check knows browser pages only, so the worker scope and its events are typed loosely here.
const sw = /** @type {any} */ (self);
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (/** @type {any} */ e) => e.waitUntil(sw.clients.claim()));

sw.addEventListener('push', (/** @type {any} */ e) => {
  let d;
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(sw.registration.showNotification(d.title || 'NewsHub.SRU', {
    body: d.body || '',
    tag: d.tag || undefined,
    lang: 'th',
    icon: '/assets/img/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : '/' },
  }));
});

sw.addEventListener('notificationclick', (/** @type {any} */ e) => {
  e.notification.close();
  // Only pages of this site
  let url = new URL(e.notification.data?.url || '/', sw.location.origin);
  if (url.origin !== sw.location.origin) url = new URL('/', sw.location.origin);
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = wins.find((/** @type {any} */ w) => w.url === url.href);
    if (same) return same.focus();
    return sw.clients.openWindow(url.href);
  })());
});
