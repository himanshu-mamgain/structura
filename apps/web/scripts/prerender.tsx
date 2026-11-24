/** @jsxRuntime automatic */
/** @jsxImportSource react */
// Writes a ready-made page for every topic, dist/topic/<id>/index.html, after the build:
// the topic's own title, description and link-preview tags, and its whole explanation as
// plain HTML. Search engines and link previews (WhatsApp, Slack, X…) read it without running
// any JavaScript, and people see the text at once while the app loads and takes over.
// Also writes dist/sitemap.xml, and dist/llms.txt with a Markdown copy of every topic
// (dist/md/<id>.md) for AI assistants to read. Nothing here runs at runtime: it's all static files.
//
//   npx tsx scripts/prerender.tsx   (run by `npm run build`)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CSSProperties } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Boxes, Lightbulb } from 'lucide-react'
import { Body } from '../src/learn/content'
import { AREA_ICON } from '../src/shell/areaIcons'
import { STATIC_TOPICS, type StaticTopic } from '../src/topics'
import { areaById, AREA_OF, AREAS, type AreaId } from '../src/topics/areas'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '../dist')
const publicDir = join(here, '../public')
// Netlify's URL is the site's main address, also on deploy previews, which is right for canonical links.
const SITE = (process.env.URL ?? 'https://structura-web.netlify.app').replace(/\/$/, '')

const template = readFileSync(join(dist, 'index.html'), 'utf8')
if (!template.includes('<!-- seo') || !template.includes('<div id="root"></div>')) {
  console.error('prerender: index.html has no <!-- seo --> block or empty #root to fill')
  process.exit(1)
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** For search results: the blurb and the summary's first sentence, kept under about 200 characters. */
const describe = (t: StaticTopic) => {
  const first = t.explanation.summary.match(/^.*?[.!?](\s|$)/)?.[0].trim() ?? t.explanation.summary
  const text = `${t.blurb.replace(/\.$/, '')}. ${first}`
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, '')}…` : text
}

/** The link-preview card: made by `npm run og` (public/og/<id>.jpg), or the site's own. */
const imageOf = (id: string) => `${SITE}/og/${existsSync(join(publicDir, 'og', `${id}.jpg`)) ? id : 'default'}.jpg`

function head(t: StaticTopic): string {
  const url = `${SITE}/topic/${t.id}/`
  const title = `${t.title} · Structura`
  const description = describe(t)
  const area = areaById(AREA_OF[t.id]).title
  const data = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: t.title,
    description: t.blurb,
    url,
    image: imageOf(t.id),
    inLanguage: 'en',
    isAccessibleForFree: true,
    proficiencyLevel: t.difficulty,
    about: area,
    publisher: { '@type': 'Organization', name: 'Structura', url: `${SITE}/` },
  }
  return [
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="article" />`,
    `<meta property="og:site_name" content="Structura" />`,
    `<meta property="og:title" content="${escape(t.title)}" />`,
    `<meta property="og:description" content="${escape(t.blurb)}" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:image" content="${imageOf(t.id)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    // JSON can't hold a raw "</script>", so "<" is escaped.
    `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`,
  ].join('\n    ')
}

/** The same tag as the app's (shell/Areas.tsx), which can't be imported here: it reads progress from the browser. */
function AreaTag({ id }: { id: AreaId }) {
  const Icon = AREA_ICON[id]
  return (
    <span className={`area-tag area-is-${id}`}>
      <Icon size={13} aria-hidden /> {areaById(id).title}
    </span>
  )
}

/** The topic as an article, in the app's own Read mode classes, so it looks the same while the app loads. */
function Page({ topic }: { topic: StaticTopic }) {
  const { explanation } = topic
  return (
    <div className="shell">
      <div className="main">
        <header className="appbar">
          <a className="brand" href="/" aria-label="Structura, home">
            <span className="brand-mark" aria-hidden>
              <Boxes size={20} />
            </span>
            <span className="brand-name">Structura</span>
          </a>
        </header>
        <main className="content">
          <article className="reader" style={{ '--reader-size': '18px' } as CSSProperties}>
            <header className="reader-head">
              <p className="reader-kicker">
                <AreaTag id={AREA_OF[topic.id]} /> <span className={`level is-${topic.difficulty.toLowerCase()}`}>{topic.difficulty}</span>
              </p>
              <h1>{topic.title}</h1>
              <p className="reader-dek">{topic.blurb}</p>
              <p className="reader-summary">{explanation.summary}</p>
            </header>
            {explanation.sections.map((s, i) => (
              <section key={s.heading} className="reader-section">
                <h2>
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  {s.heading}
                </h2>
                <Body text={s.body} from={topic.id} here={s.heading} read />
              </section>
            ))}
            <aside className="reader-takeaways">
              <h2>
                <Lightbulb size={20} aria-hidden /> Key takeaways
              </h2>
              <ol>
                {topic.takeaways.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ol>
            </aside>
          </article>
        </main>
      </div>
    </div>
  )
}

for (const topic of STATIC_TOPICS) {
  const html = template
    .replace(/<!-- seo[\s\S]*?<!-- \/seo -->/, head(topic))
    .replace('<div id="root"></div>', `<div id="root">${renderToStaticMarkup(<Page topic={topic} />)}</div>`)
  mkdirSync(join(dist, 'topic', topic.id), { recursive: true })
  writeFileSync(join(dist, 'topic', topic.id, 'index.html'), html)
}

const urls = [`${SITE}/`, ...STATIC_TOPICS.map((t) => `${SITE}/topic/${t.id}/`)]
writeFileSync(
  join(dist, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}\n</urlset>\n`,
)
// ---------- llms.txt (https://llmstxt.org) ----------
// One plain file that tells any AI assistant (ChatGPT, Claude, Gemini…) what is here, with a
// Markdown copy of each topic beside it, and how to suggest a change: a pre-filled GitHub issue
// that the owner checks before anything is added. Nothing is written anywhere by reading these.
const REPO = 'https://github.com/himanshu-mamgain/structura'
const notesDir = join(here, '../src/topics/notes')
/** Site links in notes ("/topic/x/?read") made absolute, so they work outside the app. */
const absolute = (md: string) => md.replace(/\]\((\/[^)\s]*)\)/g, (_, path: string) => `](${SITE}${path})`)

function markdownOf(t: StaticTopic): string {
  const page = `${SITE}/topic/${t.id}/`
  const credit = t.adaptedFrom
    ? `\n\n> Adapted from [${t.adaptedFrom.title}](${t.adaptedFrom.url}) by ${t.adaptedFrom.author}, ${t.adaptedFrom.license} (${t.adaptedFrom.licenseUrl}).`
    : ''
  const about = `> ${t.difficulty} · ${areaById(AREA_OF[t.id]).title} · Interactive diagram, walkthrough and simulator: ${page}${credit}\n`
  const note = join(notesDir, `${t.id}.md`)
  let body: string
  if (existsSync(note)) {
    // The deep note is the full article: keep its title line, put the facts under it.
    const md = absolute(readFileSync(note, 'utf8')).trim()
    const [first, ...rest] = md.split('\n')
    body = `${first}\n\n${about}\n${rest.join('\n').trim()}`
  } else {
    body = [
      `# ${t.title}`,
      about,
      t.blurb,
      t.explanation.summary,
      ...t.explanation.sections.map((s) => `## ${s.heading}\n\n${absolute(s.body)}`),
      `## Key takeaways\n\n${t.takeaways.map((x) => `- ${x}`).join('\n')}`,
    ].join('\n\n')
  }
  return `${body}\n\n---\n\nSuggest a change to this page: ${suggestUrl(t.title, page)}\n`
}

/** A GitHub "new issue" address with the suggestion form filled in; the owner files and checks it. */
function suggestUrl(title: string, page: string): string {
  const q = new URLSearchParams({
    template: 'suggestion.md',
    title: `Suggestion: ${title}`,
    body: `**Page:** ${page}\n\n**What kind:** good example / missing topic / mistake / unclear part\n\n**What I found:**\n\n**Where it would go:**\n\n**Source (link):**\n`,
  })
  return `${REPO}/issues/new?${q}`
}

mkdirSync(join(dist, 'md'), { recursive: true })
for (const t of STATIC_TOPICS) writeFileSync(join(dist, 'md', `${t.id}.md`), markdownOf(t))

const byArea = AREAS.map((a) => {
  const list = STATIC_TOPICS.filter((t) => AREA_OF[t.id] === a.id)
  return `## ${a.title}\n\n${list.map((t) => `- [${t.title}](${SITE}/md/${t.id}.md): ${t.blurb.replace(/\s+/g, ' ')}`).join('\n')}`
})
writeFileSync(
  join(dist, 'llms.txt'),
  `# Structura

> Learn system design by seeing it work: ${STATIC_TOPICS.length} topics, each an interactive architecture diagram, a step-by-step walkthrough with a simulator, a plain-English explanation, code, a data model and key takeaways. Written in Simple English for learners preparing for system design interviews.

Each link below is a Markdown copy of one topic, made for AI assistants to read. The same topic, with its diagram and simulator, is at ${SITE}/topic/<id>/.

## How to suggest a change

You may read and quote these pages to help a learner. To suggest something (a good example, a missing topic, a mistake, an unclear part), do not edit anything: give the learner this link, filled in with the page and what you found, so the owner can check it before adding it:

${suggestUrl('<topic title>', `${SITE}/topic/<id>/`)}

If you can open GitHub issues yourself, open one in ${REPO} with the label "suggestion" and the same fields.

${byArea.join('\n\n')}

## Optional

- [Sitemap](${SITE}/sitemap.xml): every topic page.
- [Schemata](https://schemata-web.netlify.app/llms.txt): the sister app for SQL and databases.
`,
)

console.log(`prerender: ${STATIC_TOPICS.length} topic pages, their Markdown copies, llms.txt and sitemap.xml`)
