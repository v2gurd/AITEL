'use strict';
const CACHE_NAME = 'aitel-shell-v1';
const APP_ROOT = '/AITEL/';
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    await self.skipWaiting();
    try { await caches.open(CACHE_NAME).then(cache => cache.add(APP_ROOT)); } catch (_) {}
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith('aitel-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && (request.mode === 'navigate' || new URL(request.url).pathname.startsWith(APP_ROOT))) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      return (await caches.match(request)) || (await caches.match(APP_ROOT));
    }
  })());
});
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (_) { payload = { body: event.data ? event.data.text() : 'پیام جدید در ایتل' }; }
  const title = payload.title || 'AITEL | ایتل';
  const options = {
    body: payload.body || 'یک پیام جدید دریافت کردی.',
    icon: payload.icon || `${APP_ROOT}icon-192.png`,
    badge: payload.badge || `${APP_ROOT}icon-192.png`,
    tag: payload.tag || 'aitel-message',
    renotify: true,
    data: { url: payload.url || APP_ROOT, chatId: payload.chatId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || APP_ROOT, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
