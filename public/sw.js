// Service worker: shows push notifications from the Spectacle server. No offline caching —
// a security camera app should always show live data, never a stale copy.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Spectacle', body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Spectacle', {
    body: d.body || '', tag: d.tag || 'spectacle', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png',
    data: { url: d.url || '/' }, vibrate: d.tag && d.tag.startsWith('motion') ? [200, 100, 200] : undefined,
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data.url, self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.location.origin)) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
