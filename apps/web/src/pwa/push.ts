import type { Notice } from '../learn/notify'

// Phone notifications through Web Push. The browser subscribes with the site's
// public key and hands the subscription, plus the reminders worked out from the
// learner's progress, to the push function (netlify/functions/push.mts). The
// scheduled function (push-send.mts) sends each reminder at its time, and the
// service worker (public/notify-sw.js) shows it. Progress itself stays here.

const API = '/api/push'

export type PushSupport =
  | 'ok'
  | 'ios-install' // iPhone/iPad: push works only from the Home Screen app
  | 'unsupported'
  | 'denied' // blocked in the browser's site settings

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)

export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!capable) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return 'ok'
}

export class PushError extends Error {
  constructor(
    readonly reason: 'denied' | 'not-configured' | 'failed',
    message: string,
  ) {
    super(message)
  }
}

/** The base64url VAPID key as the bytes PushManager wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function subscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

async function call(method: 'POST' | 'DELETE', body: unknown) {
  const response = await fetch(API, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (response.status === 503) throw new PushError('not-configured', "Push isn't set up on the server yet.")
  if (!response.ok) throw new PushError('failed', `The push server said ${response.status}.`)
}

/** What a reminder looks like on the wire: just what the notification shows. */
const wire = (queue: Notice[]) => queue.map(({ id, kind, at, title, body, url }) => ({ id, kind, at, title, body, url }))

let lastSynced = ''

/** Asks for permission, subscribes this browser and sends the upcoming reminders. */
export async function enablePush(queue: Notice[], newTopics: boolean): Promise<void> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new PushError('denied', 'Notifications were not allowed.')
  const keyResponse = await fetch(API)
  if (!keyResponse.ok) throw new PushError('not-configured', "Push isn't set up on the server yet.")
  const { publicKey } = (await keyResponse.json()) as { publicKey: string }
  const registration = await navigator.serviceWorker.ready
  const existing = await registration.pushManager.getSubscription()
  const sub = existing ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }))
  await call('POST', { subscription: sub.toJSON(), queue: wire(queue), newTopics })
  lastSynced = JSON.stringify([wire(queue), newTopics])
}

/** Unsubscribes this browser and forgets its reminders on the server. */
export async function disablePush(): Promise<void> {
  const sub = await subscription()
  if (!sub) return
  await call('DELETE', { endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe()
  lastSynced = ''
}

/** Sends the latest upcoming reminders, if they changed. Returns false when this browser isn't subscribed. */
export async function syncPush(queue: Notice[], newTopics: boolean): Promise<boolean> {
  const sub = await subscription()
  if (!sub) return false
  const signature = JSON.stringify([wire(queue), newTopics])
  if (signature === lastSynced) return true
  await call('POST', { subscription: sub.toJSON(), queue: wire(queue), newTopics })
  lastSynced = signature
  return true
}

/** Asks the server to push a test notification to this browser now. */
export async function testPush(): Promise<void> {
  const sub = await subscription()
  if (!sub) throw new PushError('failed', 'Phone notifications are off.')
  await call('POST', { subscription: sub.toJSON(), test: true })
}
