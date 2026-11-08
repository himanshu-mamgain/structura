import { useEffect, useState, useSyncExternalStore } from 'react'
import { Download, Share, SquarePlus, X } from 'lucide-react'
import { getInstallState, promptInstall, subscribeInstallState } from './install'

/**
 * "Install" in the app bar, beside the bell, while the app can be installed.
 * Chrome, Edge and Samsung Internet show their own install dialog; on iPhone and
 * iPad there's none, so it explains Share → Add to Home Screen instead.
 */
export function InstallButton() {
  // getInstallState returns a fresh object each call, so subscribe to its kind.
  const kind = useSyncExternalStore(subscribeInstallState, () => getInstallState().kind)
  const [help, setHelp] = useState(false)

  useEffect(() => {
    if (!help) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setHelp(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [help])

  if (kind === 'installed' || kind === 'unavailable') return null

  return (
    <div className="appbar-install">
      <button
        type="button"
        className="btn btn-primary appbar-install-btn"
        onClick={() => (kind === 'ios' ? setHelp(!help) : void promptInstall())}
        aria-expanded={kind === 'ios' ? help : undefined}
        aria-label="Install the app"
        title="Install the app: opens full screen, works offline"
      >
        <Download size={18} aria-hidden />
        <span className="appbar-install-label">Install</span>
      </button>
      {help && (
        <>
          <div className="install-scrim" onClick={() => setHelp(false)} />
          <div className="card install-popover" role="dialog" aria-label="Install on iPhone or iPad">
            <button type="button" className="icon-btn install-popover-close" onClick={() => setHelp(false)} aria-label="Close">
              <X size={16} />
            </button>
            <strong>Install Structura</strong>
            <ol>
              <li>
                In Safari, tap <Share size={15} aria-label="Share" /> <b>Share</b>.
              </li>
              <li>
                Choose <SquarePlus size={15} aria-hidden /> <b>Add to Home Screen</b>.
              </li>
              <li>Open Structura from your Home Screen.</li>
            </ol>
          </div>
        </>
      )}
    </div>
  )
}
