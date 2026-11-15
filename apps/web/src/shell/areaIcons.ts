import { BrainCircuit, Cloud, CodeXml, Database, type LucideIcon } from 'lucide-react'
import type { AreaId } from '../topics/areas'

// Each area's icon, on its own so build scripts (scripts/prerender.tsx) can use it without the app.
export const AREA_ICON: Record<AreaId, LucideIcon> = {
  development: CodeXml,
  infra: Cloud,
  databases: Database,
  ai: BrainCircuit,
}
