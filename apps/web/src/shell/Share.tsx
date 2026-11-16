import { MessageCircle } from 'lucide-react'

// Sharing is WhatsApp only, by choice. A wa.me link opens WhatsApp with the message
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
