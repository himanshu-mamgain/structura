import { Bug, Car, Container, IndianRupee, Link2, type LucideIcon, MessageSquareText, ShieldCheck, Shapes, Trophy, Waypoints } from 'lucide-react'

const ICONS: Record<string, LucideIcon> = {
  'url-shortener': Link2,
  rbac: ShieldCheck,
  'uber-surge': Car,
  'docker-vs-vm': Container,
  'twitter-timeline': MessageSquareText,
  'web-crawler': Bug,
  kafka: Waypoints,
  'payment-idempotency': IndianRupee,
  'sales-rank': Trophy,
}

/** The icon shown for a topic in the sidebar, cards and header. */
export const topicIcon = (id: string): LucideIcon => ICONS[id] ?? Shapes
