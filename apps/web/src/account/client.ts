// Loaded only when the learner signs in or already has a session, so Supabase's code
// stays out of the start-up bundle.
import { createBrowserClient } from '@supabase/ssr'
import { COOKIE_DOMAIN, COOKIE_NAME, SUPABASE_KEY, SUPABASE_URL } from './config'

export const supabase = createBrowserClient(SUPABASE_URL, SUPABASE_KEY, {
  cookieOptions: {
    name: COOKIE_NAME,
    // ".studia.dev" shares the session with every app on a subdomain; empty keeps it to this site.
    ...(COOKIE_DOMAIN && { domain: COOKIE_DOMAIN }),
    path: '/',
    sameSite: 'lax',
    secure: window.location.protocol === 'https:',
    maxAge: 60 * 60 * 24 * 400, // the longest a browser keeps a cookie: 400 days
  },
})
