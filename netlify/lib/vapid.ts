import { setVapidDetails } from 'web-push'

/**
 * The site's VAPID keys, from Netlify environment variables. Generate them once
 * with `npx web-push generate-vapid-keys`. Without them, push is simply off.
 */
export function vapid(): { publicKey: string; privateKey: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return null
  // Push services contact this address if the site's pushes misbehave.
  setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:noreply@structura-web.netlify.app', publicKey, privateKey)
  return { publicKey, privateKey }
}
