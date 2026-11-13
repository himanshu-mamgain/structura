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

export function watchForUpdates() {
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
