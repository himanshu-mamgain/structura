import { Bell, Blocks, Bug, Car, Clapperboard, ClipboardPaste, Container, Crown, DatabaseZap, Earth, FingerprintPattern, FolderSync, Gauge, IndianRupee, Link2, LockKeyhole, type LucideIcon, MapPin, MessageSquareText, MessagesSquare, Orbit, PiggyBank, ServerCog, Shapes, Share2, ShieldCheck, TextSearch, Trophy, Waypoints } from 'lucide-react'

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
  'video-streaming': Clapperboard,
  'file-sync': FolderSync,
  'leader-election': Crown,
  locking: LockKeyhole,
  'database-sharding': Blocks,
}

/** The icon shown for a topic in Explore, cards, reels and the header. */
export const topicIcon = (id: string): LucideIcon => ICONS[id] ?? Shapes
