import { useEffect, useRef, useState } from 'react'
import { Check, Link2, MessageCircle } from 'lucide-react'

// Sharing is WhatsApp and Copy link, by choice. A wa.me link opens WhatsApp with the message
// filled in: the app on a phone, WhatsApp Web or the desktop app on a computer. The
// page's own link-preview card (public/og/<id>.jpg) shows under the message.

/** The wa.me address that shares `text`, then the link to `path` on this site. */
export function whatsappHref(text: string, path: string): string {
  const url = new URL(path, window.location.origin).href
  return `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`
}

export function ShareWhatsApp({ text, path, label = 'Share on WhatsApp', className = 'btn' }: { text: string; path: string; label?: string; className?: string }) {
  return (
    <a className={`${className} share-wa`} href={whatsappHref(text, path)} target="_blank" rel="noreferrer" title="Share on WhatsApp" aria-label="Share on WhatsApp">
      <MessageCircle size={17} aria-hidden /> <span>{label}</span>
    </a>
  )
}

/** This page's address, without a sign-in fragment; a Read-mode section (#read-…) is kept. */
function hereUrl(): string {
  const { origin, pathname, search, hash } = window.location
  return origin + pathname + search + (hash.startsWith('#read-') ? hash : '')
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers, or a page that isn't served over HTTPS: copy through a hidden text box.
    const box = document.createElement('textarea')
    box.value = text
    box.setAttribute('readonly', '')
    box.style.position = 'fixed'
    box.style.opacity = '0'
    document.body.appendChild(box)
    box.select()
    const ok = document.execCommand('copy')
    box.remove()
    return ok
  }
}

/**
 * Copies a page's address. `path` names the page to copy (a topic, a reel); without it, the
 * page you are on. `iconOnly` hides the label for tight bars; the reels feed uses `size`.
 */
export function CopyLink({ path, label = 'Copy link', className = 'btn', iconOnly = false, size = 17 }: { path?: string; label?: string; className?: string; iconOnly?: boolean; size?: number }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const copy = async () => {
    const url = path ? new URL(path, window.location.origin).href : hereUrl()
    if (!(await copyText(url))) return
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 2000)
  }
  const Icon = copied ? Check : Link2
  return (
    <button type="button" className={`${className} copy-link${copied ? ' is-copied' : ''}`} onClick={copy} title={copied ? 'Link copied' : 'Copy the link to this page'} aria-label={copied ? 'Link copied' : label}>
      <Icon size={size} aria-hidden />
      {!iconOnly && <span>{copied ? 'Copied' : label}</span>}
      <span className="sr-only" aria-live="polite">{copied ? 'Link copied' : ''}</span>
    </button>
  )
}
