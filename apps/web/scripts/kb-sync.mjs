// Builds src/topics/library.json: the guide list of ByteByteGo's System Design 101
// (github.com/ByteByteGoHq/system-design-101), used as Structura's syllabus.
//
// That repo is CC BY-NC-ND 4.0 (no derivatives), so only facts are kept: each
// guide's title, categories and tags, plus a link to the original. No article
// text, descriptions or images are copied. Structura's own topics are written
// from scratch and link back to the related guides.
//
//   node scripts/kb-sync.mjs
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'ByteByteGoHq/system-design-101'
const RAW = `https://raw.githubusercontent.com/${REPO}/main`
const out = join(dirname(fileURLToPath(import.meta.url)), '../src/topics/library.json')

async function json(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'structura-kb-sync' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

async function text(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

/** Reads the YAML front matter fields we need: plain strings and simple lists. */
function frontMatter(source) {
  const block = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const fields = {}
  let list = null
  for (const line of block.split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/)
    if (item && list) {
      fields[list].push(item[1].trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    const pair = line.match(/^([A-Za-z]+):\s*(.*)$/)
    if (!pair) continue
    const [, key, value] = pair
    if (value === '') {
      list = key
      fields[key] = []
    } else {
      list = null
      fields[key] = value.trim().replace(/^['"]|['"]$/g, '').replace(/''/g, "'")
    }
  }
  return fields
}

/** Runs `task` over `items`, `limit` at a time. */
async function pool(items, limit, task) {
  const results = []
  let next = 0
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await task(items[i])
      }
    }),
  )
  return results
}

const tree = await json(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`)
const files = tree.tree.map((f) => f.path)
const guideFiles = files.filter((p) => /^data\/guides\/[^/]+\.md$/.test(p))
const categoryFiles = files.filter((p) => /^data\/categories\/[^/]+\.md$/.test(p))

const categories = (
  await pool(categoryFiles, 8, async (path) => {
    const fm = frontMatter(await text(`${RAW}/${path}`))
    return { id: path.split('/').pop().replace(/\.md$/, ''), title: fm.title, sort: Number(fm.sort ?? 999) }
  })
).sort((a, b) => a.sort - b.sort)

const guides = (
  await pool(guideFiles, 12, async (path) => {
    const fm = frontMatter(await text(`${RAW}/${path}`))
    if (fm.draft === 'true') return null
    const slug = path.split('/').pop().replace(/\.md$/, '')
    return { slug, title: fm.title, categories: fm.categories ?? [], tags: fm.tags ?? [] }
  })
)
  .filter(Boolean)
  .sort((a, b) => a.title.localeCompare(b.title))

writeFileSync(
  out,
  `${JSON.stringify(
    {
      source: {
        name: 'ByteByteGo · System Design 101',
        repo: `https://github.com/${REPO}`,
        guideUrl: 'https://bytebytego.com/guides/{slug}/',
        license: 'CC BY-NC-ND 4.0: titles and links only; read the guides on ByteByteGo.',
      },
      categories,
      guides,
    },
    null,
    1,
  )}\n`,
)
console.log(`${guides.length} guides in ${categories.length} categories → src/topics/library.json`)
