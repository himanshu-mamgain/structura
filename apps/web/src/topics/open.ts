import type { Board } from '../board/store'
import { DiagramBuilder } from '../board/builder'
import { erdToDiagram } from '../learn/erd'
import type { StaticTopic } from './types'

/**
 * Switches to the page named `title`, creating it if needed, so learning topics
 * never overwrite the user's own work. Returns true if the page already existed.
 */
export function goToTopicPage(board: Board, title: string, topicId?: string): boolean {
  return board.goToPage(title, topicId)
}

/**
 * Opens a hand-written topic on its own page: the architecture, then the
 * database schema below it. Reopening a topic whose page already has content
 * just shows it again.
 */
export async function openStaticTopic(board: Board, topic: StaticTopic) {
  const existed = goToTopicPage(board, topic.title, topic.id)
  if (!existed || board.page.nodes.length === 0) {
    // Phones in portrait get a top-to-bottom flow; wide screens left to right.
    const portrait = window.innerHeight > window.innerWidth
    await new DiagramBuilder(board).finish(portrait ? { ...topic.architecture, direction: 'down' } : topic.architecture)
    // Below, not beside: architectures are wide left-to-right flows.
    if (topic.database) await new DiagramBuilder(board, 'below').finish(erdToDiagram(topic.database))
  }
  board.fitAll()
}
