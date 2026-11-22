// The Studia account: one GitHub sign-in for Structura, Schemata and DSA Atlas, kept by
// Supabase (Auth, plus one progress row per app). Everything works signed out; with no
// Supabase settings at build time, the account button doesn't show at all.
// Set in Netlify's environment variables (see CLAUDE.md, "Studia accounts"):
//   VITE_SUPABASE_URL               https://<project-ref>.supabase.co
//   VITE_SUPABASE_PUBLISHABLE_KEY   the project's publishable (anon) key: public by design;
//                                   row-level security decides what each user may touch
//   VITE_AUTH_COOKIE_DOMAIN         .studia.dev once the apps live there, so one sign-in
//                                   covers every subdomain; empty until then
//   VITE_STUDIA_URL                 the Studia site (https://studia-web.netlify.app): sign in and
//                                   out there, so one login serves every app
//   VITE_REQUIRE_SIGN_IN            "true": a signed-out visitor is sent to Studia's login first,
//                                   then straight back to the page they asked for

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
export const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? ''
export const COOKIE_DOMAIN = (import.meta.env.VITE_AUTH_COOKIE_DOMAIN as string | undefined) ?? ''
export const STUDIA_URL = ((import.meta.env.VITE_STUDIA_URL as string | undefined) ?? '').replace(/\/+$/, '')

/** The cookie that holds the session. The same name in all three apps, so they share it. */
export const COOKIE_NAME = 'studia-auth'

/** This app's row in the shared `app_progress` table. */
export const APP_ID = 'structura'

export const accountsEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY)

/** Signing in and out happens on the Studia site. */
export const viaStudia = accountsEnabled && Boolean(STUDIA_URL)

/** Every page needs a signed-in learner (they're sent to Studia's login first). */
export const signInRequired = viaStudia && import.meta.env.VITE_REQUIRE_SIGN_IN === 'true'

/** This page's address without its #fragment, which Supabase uses to hand over a session. */
function here(): string {
  const url = new URL(window.location.href)
  url.hash = ''
  return url.toString()
}

/** Studia's login, coming back to this page afterwards. */
export const studiaLogin = (next = here()) => `${STUDIA_URL}/login?app=${APP_ID}&next=${encodeURIComponent(next)}`

/** Studia's sign-out, offering to sign back in to this app. */
export const studiaLogout = (next = window.location.origin + '/') => `${STUDIA_URL}/logout?app=${APP_ID}&next=${encodeURIComponent(next)}`

/** Studia sent a session for this app in the address's fragment (#access_token=…&refresh_token=…). */
export function handoffTokens(): { access_token: string; refresh_token: string } | null {
  const hash = new URLSearchParams(window.location.hash.slice(1))
  const access_token = hash.get('access_token')
  const refresh_token = hash.get('refresh_token')
  return access_token && refresh_token ? { access_token, refresh_token } : null
}

/** A session cookie is there (Supabase may split it into .0, .1 …). */
export const hasSessionCookie = () => document.cookie.split(';').some((c) => c.trim().startsWith(`${COOKIE_NAME}=`) || c.trim().startsWith(`${COOKIE_NAME}.`))

/** Back from GitHub with a one-time code (or an error) to finish signing in. */
export function returningFromSignIn(): boolean {
  const q = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.slice(1))
  return q.has('code') || q.has('error_description') || hash.has('error_description') || Boolean(handoffTokens())
}
