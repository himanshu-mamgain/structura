// Tracks whether the app can be installed, and offers an install action.
// Chrome/Edge/Samsung Internet fire `beforeinstallprompt`, which we keep so a
// button can show the native install dialog later. iOS Safari has no such
// event, so there we can only explain Share → Add to Home Screen.

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallState =
  | { kind: 'installed' }
  | { kind: 'available' } // native prompt ready
  | { kind: 'ios' } // needs manual Add to Home Screen
  | { kind: 'unavailable' }

let deferred: BeforeInstallPromptEvent | null = null
let installed = false
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((fn) => fn())

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

function isIos() {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac, so also check for touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

/** Call once, before React renders: the event can fire very early. */
export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault() // keep it for our own button instead of the mini-infobar
    deferred = event as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener('appinstalled', () => {
    installed = true
    deferred = null
    notify()
  })
}

export function getInstallState(): InstallState {
  if (installed || isStandalone()) return { kind: 'installed' }
  if (deferred) return { kind: 'available' }
  if (isIos()) return { kind: 'ios' }
  return { kind: 'unavailable' }
}

export function subscribeInstallState(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Shows the browser's install dialog. Returns true if the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false
  const event = deferred
  deferred = null // a prompt event can only be used once
  await event.prompt()
  const { outcome } = await event.userChoice
  notify()
  return outcome === 'accepted'
}
