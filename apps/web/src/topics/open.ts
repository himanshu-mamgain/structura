import type { Editor } from 'tldraw'
import { DiagramBuilder, fitBeside } from '../assistant/diagram'
import { erdToDiagram } from '../assistant/erd'
import type { StaticTopic } from './types'

/**
 * Switches to the page named `title`, creating it if needed, so learning topics
 * never overwrite the user's own canvas. Returns true if the page already existed.
 */
export function goToTopicPage(editor: Editor, title: string): boolean {
  const existing = editor.getPages().find((page) => page.name === title)
  if (existing) {
    editor.setCurrentPage(existing.id)
    return true
  }
  const before = new Set(editor.getPages().map((page) => page.id))
  editor.createPage({ name: title })
  const created = editor.getPages().find((page) => !before.has(page.id))
  if (created) editor.setCurrentPage(created.id)
  return false
}

/**
 * Opens a hand-written topic on its own page: the architecture, then the
 * database schema below it, framed next to the explanation card. Reopening a
 * topic whose page already has content just shows it again.
 */
export async function openStaticTopic(editor: Editor, topic: StaticTopic, leftInset: () => number) {
  const existed = goToTopicPage(editor, topic.title)
  if (!existed || editor.getCurrentPageShapeIds().size === 0) {
    await new DiagramBuilder(editor, leftInset).finish(topic.architecture)
    // Below, not beside: architectures are wide left-to-right flows.
    if (topic.database) await new DiagramBuilder(editor, leftInset, 'below').finish(erdToDiagram(topic.database))
  }
  const bounds = editor.getCurrentPageBounds()
  if (bounds) fitBeside(editor, bounds, leftInset())
}
