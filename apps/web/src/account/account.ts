import { useSyncExternalStore } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getProgress, replaceProgress, subscribeProgress, type Progress } from '../learn/progress'
import { accountsEnabled, APP_ID, hasSessionCookie, returningFromSignIn } from './config'
import { mergeProgress, stable } from './merge'

// The learner's Studia account in this app: who is signed in, and keeping their progress
// in step with the copy in Supabase. Sync is read-merge-write: fetch the account's copy,
// merge it with this device's (merge.ts), save the result here and there. So two
// devices that learned different things both keep their work.

export interface AccountUser {
  name: string
  login?: string
  avatar?: string
}

export interface AccountState {
  /** off: no Supabase settings in this build. */
  status: 'off' | 'signed-out' | 'loading' | 'signed-in'
  user?: AccountUser
  /** When progress last reached the account. */
  syncedAt?: number
  syncing?: boolean
  error?: string
}

let state: AccountState = { status: accountsEnabled ? 'signed-out' : 'off' }
const listeners = new Set<() => void>()
const set = (patch: Partial<AccountState>) => {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export function useAccount(): AccountState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  )
}

const client = () => import('./client').then((m) => m.supabase)

function userOf(session: Session): AccountUser {
  const meta = session.user.user_metadata ?? {}
  return {
    name: meta.full_name || meta.name || meta.user_name || session.user.email || 'Signed in',
    login: meta.user_name || meta.preferred_username,
    avatar: meta.avatar_url,
  }
}

let userId: string | undefined
let lastSynced = '' // this device's progress as last saved to the account
let timer: ReturnType<typeof setTimeout> | undefined
let unsubscribeProgress: (() => void) | undefined

/** Fetch the account's copy, merge it with this device's, and save the result in both places. */
export async function syncNow(): Promise<void> {
  if (!userId || state.syncing) return
  clearTimeout(timer)
  set({ syncing: true })
  try {
    const supabase = await client()
    const { data: row, error } = await supabase.from('app_progress').select('data').eq('user_id', userId).eq('app', APP_ID).maybeSingle()
    if (error) throw error
    const remote = row?.data as Progress | undefined
    const local = getProgress()
    const merged = remote?.topics ? mergeProgress(local, remote) : local
    const text = stable(merged)
    lastSynced = text // before replacing, so the change below doesn't schedule another sync
    if (text !== stable(local)) replaceProgress(merged)
    if (!remote || text !== stable(remote)) {
      const { error: saveError } = await supabase.from('app_progress').upsert({ user_id: userId, app: APP_ID, data: merged, updated_at: new Date().toISOString() })
      if (saveError) throw saveError
    }
    set({ syncing: false, syncedAt: Date.now(), error: undefined })
  } catch (e) {
    lastSynced = ''
    set({ syncing: false, error: navigator.onLine ? `Couldn't sync: ${(e as Error).message ?? 'unknown error'}` : "You're offline: progress will sync when you're back." })
  }
}

/** A change here: sync a few seconds later, so a burst of changes is one save. */
function onProgressChange() {
  if (!userId || state.syncing || stable(getProgress()) === lastSynced) return
  clearTimeout(timer)
  timer = setTimeout(() => void syncNow(), 4000)
}

function signedIn(session: Session) {
  const first = userId !== session.user.id
  userId = session.user.id
  set({ status: 'signed-in', user: userOf(session) })
  if (!first) return
  unsubscribeProgress ??= subscribeProgress(onProgressChange)
  // Not inside Supabase's auth callback: its docs warn that calling the client there can deadlock.
  setTimeout(() => void syncNow(), 0)
}

function signedOut() {
  userId = undefined
  lastSynced = ''
  clearTimeout(timer)
  unsubscribeProgress?.()
  unsubscribeProgress = undefined
  set({ status: 'signed-out', user: undefined, syncedAt: undefined, error: undefined })
}

let started = false

/** Load Supabase and follow the session. Called at start-up only when there may be one. */
async function start() {
  if (started) return
  started = true
  set({ status: 'loading' })
  const supabase = await client()
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) signedIn(session)
    else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION') signedOut()
  })
  // Back from GitHub: the client has swapped the one-time code for a session; tidy the address.
  const url = new URL(window.location.href)
  const failed = url.searchParams.get('error_description')
  if (url.searchParams.has('code') || failed) {
    for (const key of ['code', 'error', 'error_code', 'error_description', 'state']) url.searchParams.delete(key)
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    if (failed) set({ error: `GitHub sign-in didn't finish: ${failed}` })
  }
  // Save what's waiting before the page goes away, and catch up after being offline.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && timer) void syncNow()
  })
  window.addEventListener('online', () => userId && void syncNow())
}

/** At start-up: only load Supabase if this browser is signed in or coming back from GitHub. */
export function startAccount() {
  if (accountsEnabled && (hasSessionCookie() || returningFromSignIn())) void start()
}

/** Sign in with GitHub, then come back to this same page. */
export async function signIn() {
  await start()
  set({ status: 'loading', error: undefined })
  const supabase = await client()
  const back = new URL(window.location.href)
  back.hash = ''
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'github', options: { redirectTo: back.toString() } })
  if (error) set({ status: 'signed-out', error: error.message })
}

/** Sign out of the Studia account. This device keeps its progress. */
export async function signOut() {
  if (timer) await syncNow()
  const supabase = await client()
  // 'local': this browser only (and, on studia.dev, the other apps sharing its cookie), not every device.
  await supabase.auth.signOut({ scope: 'local' })
  signedOut()
}
