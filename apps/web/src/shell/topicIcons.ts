import { Bug, Car, Container, DatabaseZap, Gauge, IndianRupee, Link2, type LucideIcon, MessageSquareText, Shapes, ShieldCheck, Waypoints } from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  'url-shortener': Link2,
  rbac: ShieldCheck,
  'uber-surge': Car,
  'docker-vs-vm': Container,
  'twitter-timeline': MessageSquareText,
  'web-crawler': Bug,
  kafka: Waypoints,
  'payment-idempotency': IndianRupee,
  'key-value-store': DatabaseZap,
  'rate-limiter': Gauge,
}

/** The icon shown for a topic in the sidebar, cards and header. */
export const topicIcon = (id: string): LucideIcon => ICONS[id] ?? Shapes
