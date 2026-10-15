import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { board as defaultBoard, type Board } from './store'
import { BoardScene, type HoverInfo } from './scene'
import { perSecond } from '../sim/loadtest'

/** Re-renders the component whenever the board changes. */
export function useBoard(board: Board = defaultBoard): Board {
  useSyncExternalStore(board.subscribe, board.getVersion)
  return board
}

export interface Insets {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * Screen pixels covered by the UI on each side, so the camera frames the diagram
 * in the space that's left. Wide panels (a phone's bottom sheet) cover the
 * bottom; narrow ones (desktop side panels) cover the side they sit on.
 */
export function panelInsets(): Insets {
  const W = window.innerWidth
  const H = window.innerHeight
  const insets: Insets = { left: 0, right: 0, top: 0, bottom: 0 }
  for (const el of document.querySelectorAll('.sheet, .dock, .topbar')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    // Wide or centred (a phone sheet, the dock, the top bar): it covers the top or bottom.
    if (r.width > W * 0.6 || (r.left < W / 2 && r.right > W / 2)) {
      if (r.top > H / 2) insets.bottom = Math.max(insets.bottom, H - r.top)
      else insets.top = Math.max(insets.top, r.bottom)
    } else if (r.left < W / 2) insets.left = Math.max(insets.left, r.right)
    else insets.right = Math.max(insets.right, W - r.left)
  }
  return insets
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
