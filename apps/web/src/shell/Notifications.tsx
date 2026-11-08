import { useEffect, useState } from 'react'
import { Bell, BellOff, BellRing, CalendarClock, Hourglass, RotateCcw, Settings2, Sparkles, X } from 'lucide-react'
import course from '../learn/course.json'
import { markRead, type NoticeKind, type NotifySettings, refresh, updateSettings, upcoming, useNotify } from '../learn/notify'
import { ago, useProgress } from '../learn/progress'
import { disablePush, enablePush, PushError, pushSupport, syncPush, testPush } from '../pwa/push'
import { STATIC_TOPICS } from '../topics'

// The bell in the app bar: reminders and news in the app, and the switch for
// getting them as phone notifications too.

const ICONS: Record<NoticeKind, typeof Bell> = { daily: CalendarClock, new: Sparkles, nudge: Hourglass, review: RotateCcw }

/**
 * Keeps notifications current: adds what's due to the inbox when the app opens,
 * every minute, and when progress or settings change, and hands the upcoming
 * reminders to the push server when phone notifications are on.
 */
export function useNotificationEngine() {
  const progress = useProgress()
  const { settings } = useNotify()
  const [tick, setTick] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setTick(Date.now()), 60_000)
    // Opened from a notification (?n=id): mark it read and tidy the address.
    const url = new URL(window.location.href)
    const opened = url.searchParams.get('n')
    if (opened) {
      markRead(opened)
      url.searchParams.delete('n')
      window.history.replaceState(window.history.state, '', url)
    }
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const queue = refresh(STATIC_TOPICS, progress, Date.now(), course.quiz.length)
    if (!settings.push) return
    syncPush(queue, settings.newTopics)
      .then((subscribed) => !subscribed && updateSettings({ push: false }))
      .catch(() => {
        // Offline or the server is down: the next change or tick tries again.
      })
  }, [progress, settings, tick])
}

const KINDS: [keyof NotifySettings, string, string][] = [
  ['daily', 'Daily study reminder', "Today's plan, at your time"],
  ['newTopics', 'New topics', 'When a topic is added'],
  ['nudges', 'Unfinished topics', 'After 3 days away from one'],
  ['reviews', 'Review reminders', '1, 3 and 7 days after finishing'],
]

function PhoneNotifications() {
  const { settings } = useNotify()
  const progress = useProgress()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const support = pushSupport()

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true)
    setMessage(null)
    try {
      await action()
      setMessage(done)
    } catch (error) {
      // The browser's own reason helps most here, e.g. "push service not available".
      setMessage(error instanceof PushError ? error.message : `That didn't work: ${error instanceof Error ? error.message : 'unknown error'}. Try again.`)
    } finally {
      setBusy(false)
    }
  }

  const turnOn = () =>
    run(async () => {
      await enablePush(upcoming(STATIC_TOPICS, progress, Date.now(), course.quiz.length), settings.newTopics)
      updateSettings({ push: true })
    }, 'On. Reminders will arrive on this device at their time.')

  const turnOff = () =>
    run(async () => {
      await disablePush()
      updateSettings({ push: false })
    }, 'Off for this device.')

  return (
    <div className="notify-push">
      <h3>
        <BellRing size={16} aria-hidden /> Phone notifications
      </h3>
      {support === 'ios-install' ? (
        <p className="notify-note">On iPhone and iPad, add Structura to your Home Screen first (Share → Add to Home Screen), then open it from there and turn these on.</p>
      ) : support === 'unsupported' ? (
        <p className="notify-note">This browser can't show notifications. Reminders still appear here in the bell.</p>
      ) : support === 'denied' ? (
        <p className="notify-note">Notifications are blocked for this site. Allow them in the browser's site settings, then come back here.</p>
      ) : settings.push ? (
        <>
          <p className="notify-note">On for this device.</p>
          <div className="notify-actions">
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => run(testPush, 'Test sent. It should arrive in a few seconds.')}>
              Send a test
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={turnOff}>
              <BellOff size={16} /> Turn off
            </button>
          </div>
        </>
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={turnOn}>
          <BellRing size={16} /> Turn on
        </button>
      )}
      {message && <p className="notify-note" role="status">{message}</p>}
      <p className="notify-fine">
        Reminders are worked out on this device from your progress. Only what each notification says, and when, goes to Structura's push service.
      </p>
    </div>
  )
}

function NotifySettingsView() {
  const { settings } = useNotify()
  return (
    <div className="notify-settings">
      <h3>Remind me about</h3>
      {KINDS.map(([key, label, hint]) => (
        <label key={key} className="notify-switch">
          <span>
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
          <input type="checkbox" role="switch" checked={Boolean(settings[key])} onChange={(e) => updateSettings({ [key]: e.target.checked })} />
        </label>
      ))}
      <label className="notify-time">
        <span>Reminder time</span>
        <input type="time" value={settings.time} onChange={(e) => e.target.value && updateSettings({ time: e.target.value })} />
      </label>
      <PhoneNotifications />
    </div>
  )
}

const PROMPT_KEY = 'structura:notify-prompt'
/** After "Not now", the card stays away this long. */
const SNOOZE = 7 * 24 * 60 * 60 * 1000

const snoozedUntil = () => {
  try {
    return Number(localStorage.getItem(PROMPT_KEY) ?? 0) + SNOOZE
  } catch {
    return 0
  }
}

/** "19:00" as the learner's clock shows it, e.g. "7:00 pm". */
const clockTime = (time: string) => {
  const [h, m] = time.split(':').map(Number)
  return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * A card on Home that asks once for phone notifications, so the browser's
 * permission prompt comes from a tap with its reason in view (browsers hide
 * prompts that appear on page load).
 */
export function NotifyPrompt() {
  const { settings } = useNotify()
  const progress = useProgress()
  const [hidden, setHidden] = useState(() => Date.now() < snoozedUntil())
  const [state, setState] = useState<'ask' | 'busy' | 'done'>('ask')
  const [error, setError] = useState<string | null>(null)

  if (hidden || (settings.push && state !== 'done') || pushSupport() !== 'ok') return null

  async function turnOn() {
    setState('busy')
    setError(null)
    try {
      await enablePush(upcoming(STATIC_TOPICS, progress, Date.now(), course.quiz.length), settings.newTopics)
      updateSettings({ push: true })
      setState('done')
    } catch (e) {
      setState('ask')
      setError(e instanceof PushError ? e.message : `That didn't work: ${e instanceof Error ? e.message : 'unknown error'}.`)
    }
  }

  function notNow() {
    setHidden(true)
    try {
      localStorage.setItem(PROMPT_KEY, String(Date.now()))
    } catch {
      // Storage blocked: the card comes back next visit.
    }
  }

  return (
    <section className="card notify-prompt" aria-label="Notifications">
      <span className="notify-prompt-icon" aria-hidden>
        <BellRing size={22} />
      </span>
      {state === 'done' ? (
        <div className="notify-prompt-text">
          <strong>You're set</strong>
          <span>Your first reminder comes at {clockTime(settings.time)}. Change the time or what you get from the bell.</span>
          <div className="notify-prompt-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setHidden(true)}>
              OK
            </button>
          </div>
        </div>
      ) : (
        <div className="notify-prompt-text">
          <strong>Get a daily study reminder?</strong>
          <span>
            At {clockTime(settings.time)}, with today's topic, plus new topics and review reminders. Change or turn them off any time from the bell.
          </span>
          {error && (
            <span className="notify-prompt-error" role="status">
              {error}
            </span>
          )}
          <div className="notify-prompt-actions">
            <button type="button" className="btn btn-primary" disabled={state === 'busy'} onClick={turnOn}>
              <BellRing size={16} /> Turn on
            </button>
            <button type="button" className="btn btn-ghost" onClick={notNow}>
              Not now
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export function NotificationBell({ onOpen }: { onOpen: (url: string) => void }) {
  const { inbox, settings } = useNotify()
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'list' | 'settings'>('list')
  const unread = inbox.filter((n) => !n.read).length

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <div className="notify">
      <button
        type="button"
        className="icon-btn notify-btn"
        onClick={() => {
          setView('list')
          setOpen(!open)
        }}
        aria-expanded={open}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Bell size={20} />
        {unread > 0 && <span className="notify-count">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="notify-scrim" onClick={() => setOpen(false)} />
          <section className="card notify-panel" role="dialog" aria-label="Notifications">
            <div className="notify-head">
              <h2>{view === 'list' ? 'Notifications' : 'Notification settings'}</h2>
              {view === 'list' && unread > 0 && (
                <button type="button" className="notify-link" onClick={() => markRead()}>
                  Mark all read
                </button>
              )}
              <button type="button" className={`icon-btn${view === 'settings' ? ' is-on' : ''}`} onClick={() => setView(view === 'list' ? 'settings' : 'list')} aria-label="Notification settings" aria-pressed={view === 'settings'}>
                <Settings2 size={18} />
              </button>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
                <X size={18} />
              </button>
            </div>
            {view === 'settings' ? (
              <NotifySettingsView />
            ) : (
              <>
                {inbox.length === 0 ? (
                  <p className="notify-empty">Nothing yet. Your daily reminder, new topics, nudges and reviews will show up here.</p>
                ) : (
                  <ul className="notify-list">
                    {inbox.map((n) => {
                      const Icon = ICONS[n.kind]
                      return (
                        <li key={n.id}>
                          <button
                            type="button"
                            className={`notify-item${n.read ? '' : ' is-unread'}`}
                            onClick={() => {
                              markRead(n.id)
                              setOpen(false)
                              onOpen(n.url)
                            }}
                          >
                            <span className={`notify-icon is-${n.kind}`} aria-hidden>
                              <Icon size={17} />
                            </span>
                            <span className="notify-text">
                              <strong>{n.title}</strong>
                              <span>{n.body}</span>
                              <small>{ago(n.at)}</small>
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {!settings.push && pushSupport() !== 'unsupported' && (
                  <button type="button" className="notify-cta" onClick={() => setView('settings')}>
                    <BellRing size={16} aria-hidden /> Get these on your phone too
                  </button>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  )
}
