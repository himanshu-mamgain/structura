import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { board as defaultBoard, type Board } from './store'
import { BoardScene, type HoverInfo } from './scene'
import { perSecond } from '../sim/loadtest'

/** Re-renders the component whenever the board changes. */
export function useBoard(board: Board = defaultBoard): Board {
  useSyncExternalStore(board.subscribe, board.getVersion)
  return board
}

/** Screen pixels covered by the side panels: the card or topics list on the left, the load test on the right. */
export function panelInsets(): { left: number; right: number } {
  const left = document.querySelector('.explain')?.getBoundingClientRect().right ?? 0
  const load = document.querySelector('.load')?.getBoundingClientRect()
  return { left, right: load ? window.innerWidth - load.left : 0 }
}

/** The 3D canvas, with a stats tooltip for whatever box is under the pointer. */
export function BoardCanvas({ board }: { board: Board }) {
  const host = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)

  useEffect(() => {
    if (!host.current) return
    const scene = new BoardScene(host.current, board, panelInsets, setHover)
    return () => scene.dispose()
  }, [board])

  return (
    <div className="board" ref={host}>
      {hover && (
        <div className="board-tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <strong>{hover.label}</strong>
          {hover.stats && (
            <dl>
              <dt>Busy</dt>
              <dd>{Math.round(hover.stats.utilization * 100)}%</dd>
              <dt>Handles</dt>
              <dd>{perSecond(hover.stats.throughputPerS)}</dd>
              <dt>Queue</dt>
              <dd>{hover.stats.meanQueue < 0.1 ? 'empty' : `${hover.stats.meanQueue.toFixed(1)} waiting`}</dd>
              <dt>Waits</dt>
              <dd>{hover.stats.meanWaitMs < 0.1 ? 'none' : `${hover.stats.meanWaitMs.toFixed(1)} ms`}</dd>
              {hover.stats.rejected > 0 && (
                <>
                  <dt>Rejected</dt>
                  <dd>{hover.stats.rejected.toLocaleString()}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

/** Switches between pages (each learning topic opens on its own page). */
export function PageBar({ board }: { board: Board }) {
  useBoard(board)
  const pages = board.pageList
  return (
    <div className="pagebar">
      <select value={board.page.id} onChange={(e) => board.switchTo(e.target.value)} aria-label="Page">
        {pages.map((page) => (
          <option key={page.id} value={page.id}>
            {page.name}
          </option>
        ))}
      </select>
      <button type="button" onClick={() => board.newPage()} title="New page" aria-label="New page">
        +
      </button>
      {pages.length > 1 && (
        <button type="button" onClick={() => board.deletePage(board.page.id)} title="Delete this page" aria-label="Delete this page">
          🗑
        </button>
      )}
      <button type="button" onClick={() => board.fitAll()} title="Show everything" aria-label="Show everything">
        ⤢
      </button>
    </div>
  )
}
