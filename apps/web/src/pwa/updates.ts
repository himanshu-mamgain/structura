// The app is served from the service worker's cache, so a deploy used to reach people one
// visit late: the first open after it showed the old version while the new one downloaded
// in the background. Now, when the new version takes over before you've touched the page,
// the page reloads into it straight away. If you're already reading or clicking, it waits
// and switches at your next page change (see `navigate` in App.tsx), so nobody loses their
// place.

let ready = false
let touched = false
let lastCheck = 0

/** True once a newer version has taken over this page and it should load fresh. */
export const updateReady = () => ready

/**
 * A page still running an old version asks for that version's files (a lesson, a topic), but
 * a deploy has replaced them, so the request fails and the page would wait for ever. Load the
 * new version instead. At most once a minute, so a real network failure can't make the page
 * reload in a loop. Returns false when it didn't reload (show an error instead).
 */
export function reloadForNewVersion(): boolean {
  let last = 0
  try {
    last = Number(sessionStorage.getItem('structura:reloaded-at')) || 0
  } catch {}
  if (Date.now() - last < 60_000) return false
  try {
    sessionStorage.setItem('structura:reloaded-at', String(Date.now()))
  } catch {}
  location.reload()
  return true
}

/** Vite reports a file of the page's own version that failed to load as `vite:preloadError`. */
function reloadOnMissingFiles() {
  addEventListener('vite:preloadError', (event) => {
    if (reloadForNewVersion()) event.preventDefault()
  })
}

export function watchForUpdates() {
  reloadOnMissingFiles()
  const sw = navigator.serviceWorker
  // On a first visit nothing old is on screen, so there is nothing to swap.
  if (!sw?.controller) return

  const touch = () => {
    touched = true
  }
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) addEventListener(type, touch, { once: true, passive: true })

  sw.addEventListener('controllerchange', () => {
    if (!touched) location.reload()
    else ready = true
  })

  // An installed app can sit in the background for days without reloading, and browsers
  // only look for a new version on a page load. Look again whenever it comes back, at
  // most every half hour.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < 30 * 60_000) return
    lastCheck = Date.now()
    touched = true
    sw.getRegistration()
      .then((registration) => registration?.update())
      .catch(() => {})
  })
}
