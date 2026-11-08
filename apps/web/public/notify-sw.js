// Push notifications, added to the generated service worker with Workbox's
// importScripts (vite.config.ts). The push function sends
// { id, title, body, url, tag }; tapping the notification opens that page.

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Structura', {
      body: data.body || '',
      // One notification per kind: a newer reminder replaces an unread older one.
      tag: data.tag || 'structura',
      icon: '/pwa-192x192.png',
      badge: '/pwa-64x64.png',
      data: { url: data.url || '/', id: data.id || '' },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url = '/', id = '' } = event.notification.data || {}
  const target = new URL(url, self.location.origin)
  // Same-origin pages only; ?n= lets the app mark the reminder read.
  if (target.origin !== self.location.origin) return
  if (id) target.searchParams.set('n', id)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        try {
          await client.focus()
          await client.navigate(target.href)
          return
        } catch {
          // Not ours to steer (not controlled yet): open a new window instead.
        }
      }
      await self.clients.openWindow(target.href)
    })(),
  )
})

// The push service replaced the subscription (rare): move this browser's reminders to the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription
  const key = old && old.options && old.options.applicationServerKey
  if (!key) return
  event.waitUntil(
    (async () => {
      const fresh = event.newSubscription || (await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }))
      await fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: fresh.toJSON(), previousEndpoint: old.endpoint }),
      })
    })(),
  )
})
