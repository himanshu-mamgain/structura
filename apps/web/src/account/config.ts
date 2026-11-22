// The Studia account: one GitHub sign-in for Structura, Schemata and DSA Atlas, kept by
// Supabase (Auth, plus one progress row per app). Everything works signed out; with no
// Supabase settings at build time, the account button doesn't show at all.
// Set in Netlify's environment variables (see CLAUDE.md, "Studia accounts"):
//   VITE_SUPABASE_URL               https://<project-ref>.supabase.co
//   VITE_SUPABASE_PUBLISHABLE_KEY   the project's publishable (anon) key: public by design;
//                                   row-level security decides what each user may touch
//   VITE_AUTH_COOKIE_DOMAIN         .studia.dev once the apps live there, so one sign-in
//                                   covers every subdomain; empty until then

export const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? ''
export const SUPABASE_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? ''
export const COOKIE_DOMAIN = (import.meta.env.VITE_AUTH_COOKIE_DOMAIN as string | undefined) ?? ''

/** The cookie that holds the session. The same name in all three apps, so they share it. */
export const COOKIE_NAME = 'studia-auth'

/** This app's row in the shared `app_progress` table. */
export const APP_ID = 'structura'

export const accountsEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY)

/** A session cookie is there (Supabase may split it into .0, .1 …). */
export const hasSessionCookie = () => document.cookie.split(';').some((c) => c.trim().startsWith(`${COOKIE_NAME}=`) || c.trim().startsWith(`${COOKIE_NAME}.`))

/** Back from GitHub with a one-time code (or an error) to finish signing in. */
export function returningFromSignIn(): boolean {
  const q = new URLSearchParams(window.location.search)
  return q.has('code') || q.has('error_description')
}
