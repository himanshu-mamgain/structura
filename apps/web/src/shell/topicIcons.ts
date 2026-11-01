import { Bug, Car, Container, DatabaseZap, Gauge, IndianRupee, Link2, type LucideIcon, MessageSquareText, Orbit, ServerCog, Shapes, Share2, ShieldCheck, Trophy, Waypoints } from 'lucide-react'

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
  'consistent-hashing': Orbit,
  'rate-limiter': Gauge,
  'scaling-aws': ServerCog,
  'query-cache': DatabaseZap,
  'sales-rank': Trophy,
  'social-graph': Share2,
}

/** The icon shown for a topic in the sidebar, cards and header. */
export const topicIcon = (id: string): LucideIcon => ICONS[id] ?? Shapes
