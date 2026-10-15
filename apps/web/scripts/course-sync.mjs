// Builds src/learn/course.json (quiz questions and glossary) from Mominur Rahman's
// System Design 101 course (github.com/mominurr/system-design-101, MIT licence).
// The data arrays are read as JSON5, never executed. The MIT notice is saved to
// public/licenses/ and linked wherever the content is shown.
//
//   node scripts/course-sync.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'

const REPO = 'mominurr/system-design-101'
const RAW = `https://raw.githubusercontent.com/${REPO}/HEAD`
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function text(path) {
  const res = await fetch(`${RAW}/${path}`)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return res.text()
}

/** The source text of `const NAME = [ ... ]`, found by matching brackets outside strings. */
function arrayLiteral(source, name) {
  const start = source.indexOf('[', source.indexOf(`const ${name} =`))
  if (start < 0) throw new Error(`${name} not found`)
  let depth = 0
  let quote = null
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '[') depth++
    else if (ch === ']' && --depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`${name} never closes`)
}

const quiz = JSON5.parse(arrayLiteral(await text('js/quiz.js'), 'QUIZ_QUESTIONS')).map((q) => ({
  question: q.q,
  options: q.opts,
  correct: q.correct,
  explanation: q.explanation,
}))
const glossary = JSON5.parse(arrayLiteral(await text('js/content.js'), 'GLOSSARY'))
const license = await text('LICENSE')

mkdirSync(join(root, 'public/licenses'), { recursive: true })
writeFileSync(join(root, 'public/licenses/system-design-101-course.txt'), license)
writeFileSync(
  join(root, 'src/learn/course.json'),
  `${JSON.stringify(
    {
      source: {
        name: 'System Design 101 course by Mominur Rahman',
        repo: `https://github.com/${REPO}`,
        license: 'MIT',
        notice: '/licenses/system-design-101-course.txt',
      },
      quiz,
      glossary,
    },
    null,
    1,
  )}\n`,
)
console.log(`${quiz.length} quiz questions, ${glossary.length} glossary terms → src/learn/course.json`)
console.log('glossary entry shape:', Object.keys(glossary[0]).join(', '))
