// Builds src/topics/library.json, Structura's syllabus, from several sources:
//
// - ByteByteGo's System Design 101 (github.com/ByteByteGoHq/system-design-101),
//   CC BY-NC-ND 4.0 (no derivatives): only each guide's title, categories, tags
//   and a link are kept. No article text, descriptions or images.
// - Donne Martin's System Design Primer (github.com/donnemartin/system-design-primer),
//   CC BY 4.0: its concept chapters and worked designs, linked by section. Being
//   CC BY, Structura topics may be adapted from it, with credit.
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

// ─── System Design Primer: its README's concept chapters and worked designs ───

const PRIMER_URL = 'https://github.com/donnemartin/system-design-primer'
const readme = await text('https://raw.githubusercontent.com/donnemartin/system-design-primer/master/README.md')
/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to dashes. */
const anchor = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replace(/ /g, '-')
const lines = readme.split(/\r?\n/)
const from = lines.indexOf('## Performance vs scalability')
const to = lines.indexOf('## Appendix')
const concepts = []
for (const line of lines.slice(from, to)) {
  if (line.startsWith('## ')) {
    const title = line.slice(3)
    concepts.push({ slug: `primer-${anchor(title)}`, title, categories: ['primer-concepts'], tags: [], url: `${PRIMER_URL}#${anchor(title)}` })
  } else if (line.startsWith('### ') && concepts.length && !/^(Source|Disadvantage)/.test(line.slice(4))) {
    concepts.at(-1).tags.push(line.slice(4))
  }
}
for (const c of concepts) c.tags = c.tags.slice(0, 4)
const solutions = [...readme.matchAll(/^### (Design .+)$/gm)]
  .map((m) => m[1].trim())
  .filter((t) => !/hash map|parking lot|call center|deck of cards|chat server|least recently used/i.test(t))
  .map((title) => ({ slug: `primer-${anchor(title)}`, title, categories: ['primer-solutions'], tags: [], url: `${PRIMER_URL}#${anchor(title)}` }))

// ─── Community diagrams (no licence: linked, nothing copied) ───

const DIAGRAMS = 'https://github.com/Chaki34/system-design-diagrams'
const diagramTree = await json('https://api.github.com/repos/Chaki34/system-design-diagrams/git/trees/HEAD?recursive=1')
const diagramFolders = [...new Set(diagramTree.tree.filter((f) => f.type === 'tree' && !f.path.includes('/')).map((f) => f.path))]
const diagrams = diagramFolders.map((folder) => ({
  slug: `diagrams-${folder.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
  title: folder.replace(/^System Design - /, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  categories: ['community-diagrams'],
  tags: ['diagrams'],
  url: `${DIAGRAMS}/tree/HEAD/${encodeURIComponent(folder)}`,
}))

// ─── awesome-scalability (MIT): its curated reading list, by section ───

const SCALABILITY = 'https://github.com/binhnguyennus/awesome-scalability'
const scalabilityReadme = await text('https://raw.githubusercontent.com/binhnguyennus/awesome-scalability/master/README.md')
const scalabilitySections = []
const scalabilityLinks = []
let section = null
let subsection = null
for (const line of scalabilityReadme.split(/\r?\n/)) {
  const heading = line.match(/^## (.+)$/)
  if (heading) {
    section = /^(Content|A Piece of Cake)$/.test(heading[1]) ? null : heading[1].trim()
    subsection = null
    if (section) scalabilitySections.push(section)
    continue
  }
  if (!section) continue
  const link = line.match(/^\s*\* \[([^\]]+)\]\((https?:[^)\s]+)\)/)
  if (link) {
    const id = `scalability-${anchor(section)}`
    // Slugs come from the title (not the position) so links to them survive list changes.
    let slug = `scale-${anchor(link[1]).slice(0, 70).replace(/-+$/, '')}`
    while (scalabilityLinks.some((l) => l.slug === slug)) slug += '-2'
    scalabilityLinks.push({
      slug,
      title: link[1].trim(),
      categories: [id],
      tags: subsection ? [subsection] : [],
      url: link[2],
    })
  } else {
    // A bullet without a link names a group of links under it ("* Load Balancing").
    const group = line.match(/^\s*\* ([^[].*)$/)
    if (group) subsection = group[1].trim()
  }
}

// ─── Projects and tutorials worth knowing (linked; licences noted) ───

const references = [
  { slug: 'ref-apache-kafka-docs', title: 'Apache Kafka documentation: design and implementation', url: 'https://kafka.apache.org/documentation/#design', tags: ['Kafka', 'Apache 2.0'] },
  { slug: 'ref-apache-kafka', title: 'Apache Kafka source code', url: 'https://github.com/apache/kafka', tags: ['Kafka', 'Apache 2.0'] },
  { slug: 'ref-kafka-nodejs-tutorial', title: 'Kafka with Node.js and Docker: a sample application', url: 'https://github.com/billonline33/kafka-nodejs-tutorial', tags: ['Kafka', 'Node.js'] },
  { slug: 'ref-docker-curriculum', title: 'Docker for beginners: a comprehensive tutorial', url: 'https://docker-curriculum.com/', tags: ['Docker', 'MIT'] },
  { slug: 'ref-awesome-system-design-resources', title: 'Awesome system design resources (free interview prep)', url: 'https://github.com/ashishps1/awesome-system-design-resources', tags: ['Interviews', 'GPL-3.0'] },
  { slug: 'ref-awesome-scalability', title: 'Awesome Scalability: patterns of large-scale systems', url: SCALABILITY, tags: ['Scalability', 'MIT'] },
].map((r) => ({ ...r, categories: ['references'], source: 'references' }))

writeFileSync(
  out,
  `${JSON.stringify(
    {
      sources: {
        bytebytego: { name: 'ByteByteGo · System Design 101', repo: `https://github.com/${REPO}`, license: 'CC BY-NC-ND 4.0: titles and links only.' },
        primer: { name: 'System Design Primer (Donne Martin)', repo: PRIMER_URL, license: 'CC BY 4.0: topics adapted from it credit it.' },
        course: { name: 'System Design 101 course (Mominur Rahman)', repo: 'https://github.com/mominurr/system-design-101', license: 'MIT: quiz and glossary reused with its notice.' },
        diagrams: { name: 'System design diagrams (Chaki34)', repo: DIAGRAMS, license: 'No licence given: linked only.' },
        scalability: { name: 'Awesome Scalability (Binh Nguyen)', repo: SCALABILITY, license: 'MIT: the curated list of titles and links; each article belongs to its author.' },
        references: { name: 'Projects and tutorials', repo: 'https://kafka.apache.org/', license: 'Linked; each keeps its own licence (Kafka Apache 2.0, docker-curriculum MIT, awesome-system-design-resources GPL-3.0, link only).' },
      },
      categories: [
        { id: 'primer-concepts', title: 'Core concepts (Primer)', sort: 0, source: 'primer' },
        { id: 'primer-solutions', title: 'Worked designs (Primer)', sort: 1, source: 'primer' },
        ...categories.map((c) => ({ ...c, source: 'bytebytego' })),
        ...scalabilitySections.map((title, i) => ({ id: `scalability-${anchor(title)}`, title: `Scalability reading: ${title}`, sort: 5000 + i, source: 'scalability' })),
        { id: 'references', title: 'Projects and tutorials', sort: 9000, source: 'references' },
        { id: 'community-diagrams', title: 'Community diagrams', sort: 9999, source: 'diagrams' },
      ],
      guides: [
        ...concepts.map((g) => ({ ...g, source: 'primer' })),
        ...solutions.map((g) => ({ ...g, source: 'primer' })),
        ...guides.map((g) => ({ ...g, source: 'bytebytego', url: `https://bytebytego.com/guides/${encodeURIComponent(g.slug)}/` })),
        ...references,
        ...scalabilityLinks.map((g) => ({ ...g, source: 'scalability' })),
        ...diagrams.map((g) => ({ ...g, source: 'diagrams' })),
      ],
    },
    null,
    1,
  )}\n`,
)
console.log(`${concepts.length} primer concepts, ${solutions.length} primer designs, ${guides.length} ByteByteGo guides, ${scalabilityLinks.length} scalability readings, ${references.length} references, ${diagrams.length} diagram sets → src/topics/library.json`)
