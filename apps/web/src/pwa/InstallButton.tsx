import { useState, useSyncExternalStore } from 'react'
import { getInstallState, promptInstall, subscribeInstallState } from './install'

const DISMISS_KEY = 'structura:install-dismissed'

function readDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function InstallButton() {
  // getInstallState returns a fresh object each call, so subscribe to its kind.
  const kind = useSyncExternalStore(subscribeInstallState, () => getInstallState().kind)
  const [showIosHelp, setShowIosHelp] = useState(false)
  const [dismissed, setDismissed] = useState(readDismissed)

  if (kind === 'installed' || kind === 'unavailable' || dismissed) return null

  function dismiss() {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Storage blocked; the button just comes back next visit.
    }
  }

  return (
    <div className="install">
      <button
        type="button"
        className="install-btn"
        onClick={() => (kind === 'ios' ? setShowIosHelp(!showIosHelp) : void promptInstall())}
      >
        ⬇ Install app
      </button>
      <button type="button" className="install-close" onClick={dismiss} aria-label="Hide install button">
        ×
      </button>
      {showIosHelp && (
        <p className="install-help">
          In Safari, tap <strong>Share</strong> (the square with an arrow), then <strong>Add to Home Screen</strong>.
        </p>
      )}
    </div>
  )
}
