import { Bell, Bug, Car, ClipboardPaste, Container, DatabaseZap, Earth, FingerprintPattern, Gauge, IndianRupee, Link2, type LucideIcon, MapPin, MessageSquareText, MessagesSquare, Orbit, PiggyBank, ServerCog, Shapes, Share2, ShieldCheck, TextSearch, Trophy, Waypoints } from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  'url-shortener': Link2,
  rbac: ShieldCheck,
  'uber-surge': Car,
  'docker-vs-vm': Container,
  'twitter-timeline': MessageSquareText,
  'web-crawler': Bug,
  kafka: Waypoints,
  'payment-idempotency': IndianRupee,
  mint: PiggyBank,
  pastebin: ClipboardPaste,
  'key-value-store': DatabaseZap,
  'social-graph': Share2,
  'sales-rank': Trophy,
  'query-cache': DatabaseZap,
  'scaling-aws': ServerCog,
  'rate-limiter': Gauge,
  'consistent-hashing': Orbit,
  'chat-system': MessagesSquare,
  cdn: Earth,
  'notification-system': Bell,
  'unique-id-generator': FingerprintPattern,
  'search-autocomplete': TextSearch,
  'proximity-service': MapPin,
}

/** The icon shown for a topic in the sidebar, cards and header. */
export const topicIcon = (id: string): LucideIcon => ICONS[id] ?? Shapes
