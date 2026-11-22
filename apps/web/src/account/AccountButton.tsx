import { useEffect, useState } from 'react'
import { CloudCheck, LogIn, LogOut, RefreshCw, UserRound, X } from 'lucide-react'
import { ago } from '../learn/progress'
import { ECOSYSTEM, ECOSYSTEM_NAME } from '../ecosystem'
import { signIn, signOut, syncNow, useAccount } from './account'

const APPS = new Intl.ListFormat('en', { type: 'conjunction' }).format(ECOSYSTEM.map((a) => a.name))

/** The Studia account in the app bar: sign in with GitHub, see that progress is synced, sign out. */
export function AccountButton() {
  const account = useAccount()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (account.status === 'off') return null
  const user = account.status === 'signed-in' ? account.user : undefined

  return (
    <div className="notify account">
      <button
        type="button"
        className={`icon-btn${user?.avatar ? ' account-btn' : ''}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={user ? `Your ${ECOSYSTEM_NAME} account: ${user.name}` : `Sign in to ${ECOSYSTEM_NAME}`}
      >
        {user?.avatar ? <img className="account-avatar" src={user.avatar} alt="" width={28} height={28} referrerPolicy="no-referrer" /> : <UserRound size={20} />}
        {account.error && <span className="account-dot" aria-hidden />}
      </button>
      {open && (
        <>
          <div className="notify-scrim" onClick={() => setOpen(false)} />
          <section className="card notify-panel account-panel" role="dialog" aria-label={`${ECOSYSTEM_NAME} account`}>
            <div className="notify-head">
              <h2>{user ? `${ECOSYSTEM_NAME} account` : `Sign in to ${ECOSYSTEM_NAME}`}</h2>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {user ? (
              <div className="account-body">
                <div className="account-who">
                  {user.avatar ? <img className="account-avatar big" src={user.avatar} alt="" width={44} height={44} referrerPolicy="no-referrer" /> : <UserRound size={28} />}
                  <div>
                    <strong>{user.name}</strong>
                    {user.login && <span>@{user.login} on GitHub</span>}
                  </div>
                </div>
                <p className="account-sync">
                  {account.syncing ? (
                    <>
                      <RefreshCw size={15} className="spin" /> Syncing your progress…
                    </>
                  ) : account.error ? (
                    <span className="account-error">{account.error}</span>
                  ) : (
                    <>
                      <CloudCheck size={15} /> Progress synced{account.syncedAt ? ` ${ago(account.syncedAt)}` : ''}
                    </>
                  )}
                </p>
                <p className="account-note">One account for {APPS}. Your progress follows you to every device.</p>
                <div className="account-actions">
                  <button type="button" className="btn" onClick={() => void syncNow()} disabled={account.syncing}>
                    <RefreshCw size={16} /> Sync now
                  </button>
                  <button type="button" className="btn" onClick={() => void signOut().then(() => setOpen(false))}>
                    <LogOut size={16} /> Sign out
                  </button>
                </div>
              </div>
            ) : (
              <div className="account-body">
                <p className="account-note">
                  One free account for {APPS}. Sign in and your progress, bookmarks and finished lessons follow you to every device. Everything still works without an
                  account.
                </p>
                {account.error && <p className="account-error">{account.error}</p>}
                <button type="button" className="btn btn-primary account-signin" onClick={() => void signIn()} disabled={account.status === 'loading'}>
                  <LogIn size={17} /> {account.status === 'loading' ? 'Opening GitHub…' : 'Continue with GitHub'}
                </button>
                <p className="account-fine">GitHub shares your name, username, picture and email address with {ECOSYSTEM_NAME}. Nothing else.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
