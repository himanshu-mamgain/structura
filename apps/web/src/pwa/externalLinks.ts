// In the installed app, links to other sites open inside the app's window
// instead of throwing the learner out to the browser. A link with
// target="_blank" makes Android and desktop open a new browser tab, so the app
// seems to vanish. Opened in the same window, the site is outside the app's
// scope, so the system shows it inside the app: Android and desktop add a thin
// bar with the site's address and an ✕ back to Structura, and iPhone opens an
// in-app Safari sheet with "Done". In a normal browser tab, links still open a
// new tab, so the page you were on stays put.

import { ECOSYSTEM } from '../ecosystem'

// Sister apps (DSA Atlas) are left to the system: on a phone where that app is
// installed, the link opens it as its own app rather than inside this one.
const SISTERS = new Set(ECOSYSTEM.map((app) => new URL(app.url).origin))

const installed = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: minimal-ui)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

export function keepLinksInApp() {
  document.addEventListener('click', (e) => {
    // Ctrl/⌘-click and middle-click still mean "new window".
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !installed()) return
    const link = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!link || link.target !== '_blank' || link.hasAttribute('download')) return
    const url = new URL(link.href, window.location.href)
    // Only other sites: Structura's own files (licences, videos) keep their behaviour.
    if (url.origin === window.location.origin || SISTERS.has(url.origin) || (url.protocol !== 'https:' && url.protocol !== 'http:')) return
    e.preventDefault()
    window.location.assign(url.href)
  })
}
