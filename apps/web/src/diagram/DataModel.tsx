import { useMemo } from 'react'
import type { Erd } from '@structura/shared'
import { DbmlViewer } from 'dbml-erd-viewer'
import 'dbml-erd-viewer/styles.css'
import { erdToSchema } from '../learn/dbml'

/** A topic's tables as an interactive ERD: drag tables, pinch to zoom, hover a link to see its columns. */
export default function DataModel({ erd, narrow }: { erd: Erd; narrow: boolean }) {
  const schema = useMemo(() => erdToSchema(erd), [erd])
  return (
    <DbmlViewer
      schema={schema}
      className="data-model"
      showMiniMap={false}
      layoutOptions={{ algorithm: 'elk', direction: narrow ? 'TB' : 'LR', minNodeWidth: 150, maxNodeWidth: 280 }}
    />
  )
}
