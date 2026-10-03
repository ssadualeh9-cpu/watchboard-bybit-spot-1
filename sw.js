// Watchboard SW — no HTML cache; notifications copyable via data.copy
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname === "/" || url.pathname.endsWith(".html") || url.pathname === "/index.html") {
    e.respondWith(fetch(e.request, { cache: "no-store" }));
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const copy = (e.notification.data && e.notification.data.copy) || e.notification.body || "";
  e.waitUntil((async () => {
    const clientsList = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of clientsList) {
      try {
        c.postMessage({ type: "wb_copy", text: copy });
        if ("focus" in c) { await c.focus(); return; }
      } catch (err) {}
    }
    if (clients.openWindow) await clients.openWindow("/");
  })());
});
