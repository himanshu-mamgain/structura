import type { Lesson } from './lessonTypes'

// Which topics have a lesson, and loading one. Each lesson is its own small chunk,
// fetched when Lesson mode opens.

const files = import.meta.glob<{ default: Lesson }>('./lessons/*.ts')
const path = (id: string) => `./lessons/${id}.ts`

export const hasLesson = (id: string) => path(id) in files

export async function loadLesson(id: string): Promise<Lesson | null> {
  const load = files[path(id)]
  return load ? (await load()).default : null
}

/** The lesson button's words: start it, carry on where you stopped, or go through it again. */
export function lessonLabel(progress?: { lessonStep?: number; lessonDone?: boolean }): string {
  if (progress?.lessonDone) return 'Lesson again'
  if (progress?.lessonStep) return 'Continue lesson'
  return 'Start lesson'
}
