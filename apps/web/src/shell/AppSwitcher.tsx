import { useEffect, useState } from 'react'
import { LayoutGrid, X } from 'lucide-react'
import { ECOSYSTEM, type EcoAppId } from '../ecosystem'

const THIS_APP: EcoAppId = 'structura'

/** Switch between Himanshu's apps. Opens like the notification panel (a sheet on phones, a dropdown on desktop). */
export function AppSwitcher() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="notify apps">
      <button type="button" className="icon-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="Your apps">
        <LayoutGrid size={20} />
      </button>
      {open && (
        <>
          <div className="notify-scrim" onClick={() => setOpen(false)} />
          <section className="card notify-panel apps-panel" role="dialog" aria-label="Your apps">
            <div className="notify-head">
              <h2>Your apps</h2>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            <ul className="apps-list">
              {ECOSYSTEM.map((app) => {
                const here = app.id === THIS_APP
                return (
                  <li key={app.id}>
                    <a className="apps-item" href={here ? '/' : app.url} aria-current={here ? 'page' : undefined} onClick={() => setOpen(false)}>
                      <span className="apps-mark" style={{ background: app.color }} aria-hidden>
                        {app.name[0]}
                      </span>
                      <span className="apps-text">
                        <strong>{app.name}</strong>
                        <span>{here ? "You're here" : app.tagline}</span>
                      </span>
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
