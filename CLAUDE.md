# Structura

A PWA for learning system design by seeing it work. Each topic is an interactive,
hand-drawn architecture diagram (rough.js), a step-by-step walkthrough with a
"try your own input" simulator, an explanation, code, a data model, key
takeaways and (for some) a narrated Remotion video. Deployed to Netlify as a
static site from `main`: https://structura-web.netlify.app

## Hard rules

- **No LLMs and no backend at runtime.** Everything runs in the browser. Don't add
  API calls, servers, API keys or LLM features to the app. On-device speech is fine
  (the voice assistant runs Kokoro in a Web Worker; its "brain" is search, not AI). (`apps/server` was
  deleted on purpose; a Render build failing on `@structura/server` is expected.)
  **The one exception is push notifications** (`netlify/functions`, see "Notifications"
  below): they only store and send reminder texts the browser worked out. Don't grow
  them into a general backend, and never send learner progress to them. (The owner's
  Notion notes are fetched at **build** time, not at runtime: see "Notion notes". The
  second, owner-approved exception is `/api/notion-note`, which only appends a note the
  owner writes and seals with his notes key; nothing else may write to Notion.)
  **The third, owner-approved exception is the Studia account** (Supabase, see "Studia
  accounts"): an optional GitHub sign-in shared by Structura, Schemata and DSA Atlas, and each
  signed-in learner's own progress row, guarded by row-level security. Every page works signed
  out; nothing else goes to Supabase, and there is no server code of ours. Don't grow it into
  more without the owner asking.
- **Work on a branch and open a pull request, then merge it. Never push to `main`.**
  Every change lands through a PR, and the owner wants Claude to merge its own PRs
  (including the daily topic routine's) once the Netlify deploy preview and any CI
  pass and the PR is mergeable, with a merge commit. If a check fails, fix it on the
  branch; if it can't be made green or a conflict can't be resolved safely, leave the
  PR open and say what is blocking.
- **Respect source licences** (see "Sources" below). When in doubt, link, don't copy.
- Keep the mobile-first layout working: check anything visual at 390px wide too.

## Repo

npm workspaces, TypeScript 7, React 19, Vite 8.

- `apps/web`: the app.
  - `src/topics/`: one file per topic (`url-shortener.ts`, `twitter-timeline.ts`, …),
    registered in `src/topics/index.ts`. Types in `src/topics/types.ts`.
  - `src/topics/catalog.json` (+ `catalog.ts`): what the app knows about each topic before it
    opens (title, blurb, level, video, section headings, guides). Generated from the topics by
    `npm run catalog`, and by `dev` and `build`; commit it. **Anything outside the topic page
    reads `TOPICS` from `catalog.ts`, never `STATIC_TOPICS`**: importing `src/topics` there puts
    every topic back into the start-up bundle. Full topics load on demand (`loadTopic(id)`).
  - `src/topics/library.json`: the syllabus (generated, see below). `library.ts` reads it.
  - `src/topics/areas.ts`: the four areas, **Development, Infra, Databases and AI**, each topic's area
    (`AREA_OF`) and the library categories that belong to each. Explore (`?page=explore&area=infra`),
    Home's area cards, search, the topic page's tag and the roadmap's tracks (`?page=roadmap&area=…`)
    are all organised by them; `src/shell/Areas.tsx` has the chips, cards and tag.
  - `src/shell/`: app shell. `App.tsx` (routes: a topic lives at `/topic/<id>/` (old `?topic=<id>` links
    still work and are tidied), with `?read`, `?learn` or `?load` after it; other pages use `?page=explore|reels|listen|quiz|glossary|roadmap`,
    `?page=reels&reel=<id>`, `?library=`; the five Instagram-style tabs, along the bottom on
    phones and in the top bar from 1024px), `Home.tsx` (reels row first), `Explore.tsx`
    (search, topic grid, library), `Reels.tsx` (full-screen video feed), `Search.tsx`,
    `TopicView.tsx`, `Reader.tsx` (Read mode, `?topic=<id>&read`), `Lesson.tsx` (Lesson mode,
    `?topic=<id>&learn`: swipeable cards that light up the diagram, then a quick check; the
    diagram sits above the card on phones and beside it from 768px), `Practice.tsx`, `Roadmap.tsx` (where to start: each area's track in four
    stages, Foundations → Intermediate → Advanced → Expert, of small module cards from
    `src/learn/roadmap.ts`; a card opens its steps at `?page=roadmap&part=<id>`), `topicIcons.ts`. There's no sidebar: anything fixed
    to the bottom of the screen sits above the tab bar (`bottom: calc(… + var(--tabbar))`).
  - **Ready-made pages** (`scripts/prerender.tsx`, the step after `vite build`): every topic gets
    `dist/topic/<id>/index.html` with its own title, description, canonical link, Open Graph and
    JSON-LD, and its explanation as plain HTML in Read mode's classes, so search engines and link
    previews read it without JavaScript, and the text shows while the app loads. Also
    `dist/sitemap.xml`. Static files only: there's still no server. `index.html` holds the home page's
    tags between `<!-- seo` and `<!-- /seo -->`; keep those markers.
  - **Icons**: `public/favicon.svg` (the app bar's green tile with lucide's "boxes" glyph) is the source of the
    favicon and every app icon; `pwa-assets.config.ts` makes the PNGs from it at build, and
    `npx pwa-assets-generator` in `apps/web` redraws the copies in `public/`. The notification badge
    (`public/badge-96x96.png`) is the glyph alone, from `scripts/badge.svg`.
  - `public/og/<id>.jpg`: each topic's link-preview card (1200 × 630), drawn by
    `npm run og -w @structura/web` (Playwright, run locally like the videos; `default.jpg` is the site's).
  - `src/diagram/`: the 2D diagram (`Diagram2D.tsx`), its ELK layout (`layout.ts`), box icons (`icons.ts`),
    component inspector logic (`inspect.ts`). The "Data model" view is `DataModel.tsx`: the topic's `database`
    drawn by [dbml-erd-viewer](https://github.com/usingsky/dbml-erd-viewer) (MIT, lazy-loaded). `src/learn/dbml.ts`
    turns an `Erd` into DBML (the Schema tab's DBML tab) and into the viewer's schema directly, so the browser
    never loads the 2.6 MB DBML parser (`vite.config.ts` aliases `@dbml/core` to a stub).
    `npm run test:dbml` checks that parsing the DBML gives exactly that schema for every topic.
  - `src/sim/`: the load test: the Rust/WASM simulator's worker (`engine.ts`), the knobs (`loadtest.ts`)
    and the panel (`LoadPanel.tsx`), whose results show as a busy badge on each box of the 2D diagram.
    There is no 3D view: it was removed on purpose; don't bring three.js back into the app.
  - Sharing is **WhatsApp only** (the owner's choice): `src/shell/Share.tsx` makes a `wa.me` link with the
    title, blurb and page address, on each topic page, Read mode's bar and Home. Don't add other share options.
  - `src/learn/`: content blocks, walkthrough, progress (localStorage), quiz/glossary data.
  - `src/account/`: the Studia account (see "Studia accounts"): the app bar's account button,
    GitHub sign-in through Supabase, and progress sync (`merge.ts`, `npm run test:sync`).
  - **Deep links** (`src/learn/links.ts`): when a topic's text mentions what another topic teaches
    ("Redis Sentinel", "rate limiter", "circuit breaker"), the first mention in each section links
    there, to the exact Read-mode section when the rule names one (`/topic/<id>/?read#read-<heading>`).
    `LINK_RULES` is written by hand: specific rules first, `exact` for names and acronyms, `near` for
    words that only mean this next to a context word (a "replica" near "Redis"), `far` to skip a
    paragraph, `inTopic` to link a term to its own topic's article section. Applied to section text,
    summaries, takeaways, walkthrough steps (in Read mode) and deep notes; App.tsx opens the links in
    the app and scrolls to the section. `npm run test:links` checks every target topic and heading exists.
  - CSS: `index.css` (panel internals), `shell.css` (layout), `features.css` (newer features).
  - `src/ecosystem.ts`: the owner's other apps (DSA Atlas, Schemata for SQL and databases), in the
    app switcher; the Databases area and roadmap track link to Schemata.
  - Links to other sites use `target="_blank" rel="noreferrer"`. In the installed app,
    `src/pwa/externalLinks.ts` opens them in the app's own window instead, so learners stay
    in Structura (Android and desktop show a bar with an ✕ back; iPhone shows a Safari sheet).
- `apps/video`: Remotion videos (narration in `src/narration/*.json`).
- `packages/shared`: zod schemas for diagrams, ERDs, traces and explanations (`src/schemas.ts`).
- `packages/sim`: Rust load simulator compiled to WASM. `pkg/` is committed, so
  **Rust is not needed** unless you change `packages/sim/src`.

## Commands

```bash
npm install
npm run typecheck                  # all workspaces; must pass
npm run build -w @structura/web    # production build; must pass before a PR
npm run dev                        # local dev server (port 5173)
npm run library -w @structura/web  # refresh library.json from the sources
```

## Adding a topic (the common request)

Use `apps/web/src/topics/twitter-timeline.ts` as the model; it has every part.

1. **Create `apps/web/src/topics/<id>.ts`** exporting a `StaticTopic`:
   - `id` (kebab-case), `title`, `blurb` (one line), `difficulty` (`Beginner` | `Intermediate` | `Advanced`).
   - `architecture`: a `Diagram`. 5 to 16 nodes, at most 24 edges and 6 groups.
     Labels at most 48 characters, ids at most 32. **List the user/client node first**:
     layout starts the flow there. Shapes: `ellipse` for actors, `diamond` for
     decisions, `cloud` for the internet, `rectangle` otherwise. Colours: `blue`
     clients, `violet` services, `green` data stores, `red` caches, `orange` workers,
     `yellow` queues.
   - `database`: an `Erd` (tables, columns, indexes, relations) or `null`.
   - `explanation`: `summary` plus sections, in this order when they apply:
     Overview, Requirements, Capacity estimates, Step by step, Components, Key
     decisions, Scaling and failure, Interview follow-ups.
     - **Step by step**: numbered lines that use the exact node labels.
     - **Components**: one line per box, `- <Exact Label>: what it does.` The
       component inspector reads these lines; a box without one shows a fallback.
   - `explanation.trace`: 2 to 12 steps; each step's `nodes` are **exact node labels**
     (that's how the walkthrough highlights boxes); `data` shows the real request,
     row, cache entry or response at that step.
   - `simulator` (recommended): a few `options` fields and a `run()` that returns a
     trace computed from the input, so the learner sees cause and effect (see the
     celebrity fan-out switch in twitter-timeline). Make `explanation.trace` a getter,
     `get trace() { return defaultTrace(simulator) }` (from `./simulator`), so the
     simulator runs when the topic is opened, not when the app starts.
   - `code`: up to 4 short, runnable snippets with brief comments. Write each in
     **JavaScript** first (`language: 'javascript'`), then add the same code in **Java**
     (and TypeScript, Python or Go when they help) under `versions: [{ language, source }]`.
     The code block shows one tab per language, JavaScript first, and remembers the
     learner's pick across topics. SQL and bash snippets stay single-language.
   - `takeaways`: 5 or 6 one-sentence points.
   - `guides`: related slugs from `library.json` (search it by title).
   - `adaptedFrom`: required when the topic is adapted from a CC BY source.
   - **Deep notes** (`src/topics/notes/<id>.md`, recommended): the article read mode shows
     instead of the explanation, written like the owner's Notion study notes. `# Title`, then a
     `> 💡 **TL;DR**` callout, then `##` sections: an at-a-glance table, how it works underneath,
     real code, a "How to choose" guide, `## ⚠️ Critical Mistakes`, `## Interview Q&As`
     (`**Q: …**` then `A: …`), related topics (`/?topic=<id>&read` links), sources and
     `## Why This Matters`. `docker-vs-vm.md` is the model; `src/learn/markdown.ts` lists the
     Markdown it reads (tables, code fences, callouts, nested lists). **Every note follows
     "Notes that explain everything" below**; `npm run catalog` (so every build) stops if a note fails
     its checks.
   - **Lesson** (`src/topics/lessons/<id>.ts`, recommended): Lesson mode's cards, in Simple
     English (see "Style"). 7 to 10 cards, each a `title`, a `text` of 2 to 4 short sentences, and
     optionally `focus` (exact node labels to light up), an `example` (a command, a worked number,
     a few lines of JSON) and a one-line `remember`. Then exactly 3 questions with 4 options, the
     `answer` index (vary where the right one sits) and a `why`. `npm run catalog` stops if a focus
     label isn't a box in the diagram. `docker-vs-vm.ts` is the model.
2. **Register it** in `src/topics/index.ts` (`STATIC_TOPICS`), **give it an area** in `AREA_OF`
   (`src/topics/areas.ts`: `development`, `infra`, `databases` or `ai`; the build stops without one),
   and **give it a step in the roadmap** (`src/learn/roadmap.ts`) in a module of the same area and the
   right stage (a new module is fine). Unplaced topics still show, at the end of their area, under "More topics".
   **Add link rules** in `src/learn/links.ts` for the terms the new topic teaches, pointing at its deep
   note's sections where it has them, then run `npm run test:links`.
   **Find where it's asked** (see "Asked at" below) and add what you find to `src/topics/askedAt.json`.
3. **Pick an icon** in `src/shell/topicIcons.ts` (any `lucide-react` icon), and draw its
   link-preview card with `npm run og -w @structura/web` (it only draws topics that have none).
4. **Check** `npm run typecheck`, `npm run test:notes` and `npm run build -w @structura/web`.
5. **Make its video and audio lesson** (see below) if the Kokoro setup is available.
6. **Open a PR** titled `feat: add <title> topic`, saying what the walkthrough and
   simulator show and which source it is based on (with licence).

Numbers in examples must be correct: compute them (base62 codes, capacity
estimates, hashes) rather than guessing. Use realistic example data.

## Notes that explain everything

A learner reads a deep note on their own, often on a phone, with no one to ask. So a note must
answer every "what is that?" before the reader has to ask it. These rules apply to new notes and to
every edit of an old one. They come from real gaps the owner hit: the ECS note used "Fargate" all
the way through without ever saying what it is; "0.25 vCPU" was used before vCPU was explained; the
token bucket said "one token every 6 s" in one place and "0.167 a second" in another without linking them.

1. **Say what the subject is, first.** In the TL;DR or the section right after it, define in plain
   words everything the title names: what it is, what problem it solves, and what you would do
   without it. If the title names two things ("ECS on Fargate"), define both, each in its own
   paragraph or a "What X is" section.
2. **Explain every term where it first appears**, in the same sentence: "A hypervisor is software
   that…", "each task gets an ENI (elastic network interface: a network card)". A term you **bold**
   is a term you are teaching, so it is explained right there. A link to the Structura topic that
   teaches the term also counts.
3. **Spell out every abbreviation** the first time: `ENI (elastic network interface)` or
   `elastic network interface (ENI)`, even if another topic explained it. Only the everyday ones in
   `KNOWN_ABBREVIATIONS` (`src/learn/noteRules.ts`: API, HTTP, JSON, CPU…) are exempt. Commands,
   signals, states and setting names are code, not words: `SIGTERM`, `INCR`, `PENDING`, `"cpu": "512"`.
4. **Explain every number.** Give its unit, show where it comes from (60 s ÷ 10 = 6 s), and say
   what it means for the reader. When a quantity can be written two ways (a rate and a period:
   0.167 tokens a second is one token every 6 s), give both, side by side, and say which the code
   uses. Compute numbers; never guess them.
5. **Explain every code or config block**: a sentence before it says what it does, and the values
   that aren't obvious are explained after it (`"cpu": "512"` is 0.5 vCPU).
6. **Follow one real example all the way through**: one request, one order, one client, with real
   numbers, usually as a table of steps. A rule stated only in the abstract isn't explained yet.
7. **Say what it costs and where it stops**: what happens without it, the trade-offs, the limits
   (Fargate: no GPUs, at most 16 vCPU), and what to use instead.
8. **Check facts that change** (prices, limits, quotas, defaults) against the official docs. Name
   the region or version, and link the page under `## Sources`.
9. **Answer the newcomer's six questions** somewhere in the note: What is it? Why does it exist? How
   does it work underneath? What does it cost and where does it stop? What goes wrong? How do I choose?
10. **Tables and lists stand alone**: every header and cell makes sense without the paragraph above
    it, and every term in them follows rules 2 and 3.

Before you finish a note, read it top to bottom as someone new to the topic. For every noun in the
TL;DR and every bold term, point to where it is explained; if you can't, explain it.

What `npm run test:notes` (and `npm run catalog`) checks, from `src/learn/noteRules.ts`:

- The note starts with `# Title`, then the `> 💡 **TL;DR**:` callout.
- It has `## How to choose` (a heading that starts with it is fine), `## ⚠️ Critical Mistakes`,
  `## Interview Q&As` with at least 3 `**Q: …**` each answered by `A: …`, `## Related topics`,
  `## Sources` and `## Why This Matters`. No section is empty.
- Every abbreviation (two or more capitals, such as ENI or EC2) is explained where it first
  appears outside code and headings: followed by `(…)` (up to two words may come between, as in
  "NAT gateway (…)"), written as `full name (ABBR)`, followed by "is" or "means", alone in a table
  cell, or inside a link to a Structura topic. `## Sources` is skipped: those are other people's titles.

The check can't tell whether an explanation is good, only that one is there; rules 1, 2 and 4 to 10
are yours to keep.

## Asked at (which companies ask a topic)

Every topic shows "Asked at Amazon · Google · …" under its title (`src/shell/AskedAt.tsx`), from
`src/topics/askedAt.json`. Tapping it lists each report: the question as the candidate wrote it, where
it was reported and when, with a link. `topicsAskedAt(company)` in `src/learn/askedAt.ts` is there for
company prep guides.

**Before adding a topic, or when updating one, search the web for where it was asked**, and update
the file (and its `checked` date):

- Look at candidates' reports: PracHub's company pages (`prachub.com/companies/<company>/categories/system-design`,
  `?page=2`…, each question page names the company, role, round and date), IGotAnOffer's company system design
  guides (questions reported on Glassdoor), LeetCode Discuss interview experiences. Search
  `site:prachub.com <topic>` and open the question page to read its company.
- One entry per report: `company` (add it to `companies`, best known first), `question` exactly as reported,
  `url` of that report, `source`, `date` when the source gives one. Add `"similar": true` when the
  question is a close variant rather than the same design (a news feed for the Twitter timeline).
- **Never add a company without a link to a report**, and never from memory or "commonly asked" lists.
  A topic with nothing found shows nothing. Re-open a few links to check them before committing.
- `npm run test:asked` checks every topic, company, source, link and date.

## Sources and licences

| Source | Licence | Allowed |
|---|---|---|
| [System Design Primer](https://github.com/donnemartin/system-design-primer) | CC BY 4.0 | Adapt into topics, with `adaptedFrom` credit and a note of what changed |
| [ByteByteGo System Design 101](https://github.com/ByteByteGoHq/system-design-101) | CC BY-NC-ND 4.0 | Titles and links only. No text, diagrams or descriptions |
| [mominurr/system-design-101](https://github.com/mominurr/system-design-101) | MIT | Quiz and glossary reused with the notice in `public/licenses/` |
| [Chaki34/system-design-diagrams](https://github.com/Chaki34/system-design-diagrams) | none | Links only |
| [awesome-scalability](https://github.com/binhnguyennus/awesome-scalability) | MIT | Its reading list (titles and links) is in the library; the articles belong to their authors |
| [awesome-database-learning](https://github.com/pingcap/awesome-database-learning) | none | **Link only**: the library links to its README sections (`db-*` slugs); its list is not copied |
| [Apache Kafka](https://github.com/apache/kafka) docs | Apache 2.0 | May be adapted, with credit |
| [docker-curriculum](https://github.com/prakhar1989/docker-curriculum) | MIT | May be adapted, with credit |
| [awesome-system-design-resources](https://github.com/ashishps1/awesome-system-design-resources) | GPL-3.0 | **Link only**: copying would make Structura's code GPL |
| [kafka-nodejs-tutorial](https://github.com/billonline33/kafka-nodejs-tutorial) | none | Link only |
| [amazon-ecs-fullstack-app-terraform](https://github.com/aws-samples/amazon-ecs-fullstack-app-terraform) | MIT-0 | May be adapted; credit it anyway |
| [terraform-aws-modules](https://github.com/terraform-aws-modules) (ECS, VPC, ALB) | Apache 2.0 | May be adapted, with credit |
| [aws/containers-roadmap](https://github.com/aws/containers-roadmap) | CC BY-SA 4.0 | **Link only**: adapting it would make Structura's text share-alike |
| Interview prep repos (javascript-algorithms, neetcode, coding-interview-university, karanpratapsingh/system-design, javascript-questions, javascript-interview-questions, nodebestpractices, tech-interview-handbook) | various | **Link only**: the `prep-*` library categories and the Interview prep page (`?page=prep`) link to them with Structura's own one-line notes |

Otherwise, write topics from your own knowledge. The library (`library.json`)
is the syllabus: topics not yet built are good candidates.

## Videos and audio lessons

Narration uses **Kokoro** (open-weight TTS, Apache 2.0) from `apps/video/.venv`, so it
works on Linux cloud sessions too. One-time setup (Python 3.10 to 3.12):

```bash
cd apps/video
uv venv .venv --python 3.12        # or: python3.12 -m venv .venv
uv pip install --python .venv torch --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv "kokoro>=0.9.4" soundfile pip
```

The house voice is `am_michael` at 0.96 speed (~158 words a minute; see
`apps/video/scripts/measure_voices.py`), loudness -14 LUFS.

**Sarvam Bulbul v3 (Indian English), speaker `shubh` at pace 1.0, is the narration voice
going forward**, chosen by the owner from the samples. It is a hosted API, so it is used only to generate audio ahead of time, never by the
app at runtime. This cloud workspace can't reach `api.sarvam.ai`, so narration is made by the
**Narrate with Sarvam Bulbul** GitHub Action (`.github/workflows/narrate.yml`, run by hand;
needs the `SARVAM_API_KEY` repository secret). It voices `samples` (a passage per speaker at
`/voice-samples/index.html` on the PR's preview, for picking a narrator; close that PR),
`lessons`, `videos` or `both`, for the topics given (empty = all), and opens a PR with the
audio. The engine is `apps/video/tts/sarvam.mjs` (clips cached in `apps/video/.cache/sarvam`);
locally, `TTS_ENGINE=sarvam TTS_VOICE=<speaker> TTS_PACE=1` (or `--engine=sarvam`) switches
`voice.mjs`, `render-topics.ts` and `lessons.ts` to it. `SARVAM_API_URL` points it at a mock.

- **Topic videos (automatic):** every topic without a hand-made video gets one.
  After adding a topic: `npm run export:videos -w @structura/web`, then
  `npm run topics -w @structura/video` (voices, renders `public/videos/<id>.mp4`,
  makes the thumbnail, a small `<id>-sm.jpg` copy for tiles, and the chapters, and registers it in `src/topics/videos.json`).
  Rendering takes a few minutes per video; videos are committed.
- **Commute-mode audio lessons:** `npm run lessons -w @structura/web -- <topic-id>`
  writes `public/lessons/<id>/*.m4a` and `src/learn/lessons.json`.
- **Hand-made videos** (URL shortener, RBAC, Uber, Docker) live in `apps/video/src/*.tsx`;
  their narration still uses Windows voices (`npm run voice`), Windows only.
- **Card reels** (Idempotent Payments, `src/IdempotentPayments.tsx` with the kit in
  `src/cards/`) use Kokoro in Node instead: a narration whose `voice` is a Kokoro id
  and has no `"engine"` goes through `tts/kokoro.mjs` (no Python; installs itself on
  first use), which also masters the audio and writes word timings for the karaoke
  captions. `npm run voice -w @structura/video -- payment-idempotency`, then
  `npm run render:payments -w @structura/video`.
- **A topic's own short reels**: a topic can list extra reels besides its main video
  (`reels: [{ id, title, blurb, video, chapters }]` in the topic file). They play in the Reels feed
  (`?page=reels&reel=<id>`, each with its own progress) and show as covers on the topic page. The
  Rate Limiter has one per algorithm (`apps/video/src/RateLimiterReels.tsx`, the card kit, Kokoro):
  `npm run voice -w @structura/video -- rate-limiter-fixed-window …`, then
  `npm run render:rate-limiter -w @structura/video`, and a cover with `remotion still … --scale=0.5`
  plus its `-sm.jpg` copy. Chapters: `npx tsx scripts/chapters.ts <video>` in `apps/video`. Here,
  Remotion can't download its own Chrome: pass `--browser-executable=` the Playwright
  `chrome-headless-shell` under `/opt/pw-browsers`.

## Notifications

The bell in the app bar (`src/shell/Notifications.tsx`) shows a daily study reminder
(the "Today" plan), new topics, a nudge after 3 days away from an unfinished topic,
and reviews 1, 3 and 7 days after finishing one. They're worked out in the browser
from progress (`src/learn/notify.ts`).

Phone notifications use Web Push through Netlify Functions:

- `/api/push` (`netlify/functions/push.mts`) stores each browser's subscription and
  its upcoming reminders (text, link, time) in Netlify Blobs.
- `push-send.mts` runs every 15 minutes in production, sends what's due, and announces
  topics added since its last run (from `/topics.json`, written by `npm run build`).
- `public/notify-sw.js` (added to the service worker) shows them and opens the page.
- Logic lives in `netlify/lib/push.ts`; test it with `npm run test:push`.
- Setup, once: `npx web-push generate-vapid-keys`, then set `VAPID_PUBLIC_KEY`,
  `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` address) in Netlify's
  environment variables. Without them push is off and the bell still works.
- iPhone and iPad get push only from the Home Screen app (iOS 16.4+).

## Notion notes

The owner's Notion notes (his "System Design" page and its sub-pages) are built into
the site by `apps/web/scripts/notion.ts`, the last step of `npm run build`, into
`dist/notion/` (an index plus one file per note, images saved beside them). The app
shows them in Explore ("Your notes"), in a reader (`?note=<id>`), in search, and under
the takeaways of matching topics (`notesFor` in `src/learn/notes.ts` matches note titles
to topics; add words to its `ALIASES` to link more). Format and encryption:
`src/learn/notesFormat.ts`.

- Netlify environment variables: `NOTION_TOKEN` (an internal integration's secret; the
  page must be shared with it), `NOTION_ROOT_PAGE_ID`, `NOTION_PASSPHRASE` (encrypts every
  file with AES-GCM; the app asks for it once and keeps the derived key, not the
  passphrase) and optionally `NOTION_EXCLUDE` (comma-separated titles to leave out).
- Without a token the step is skipped and the app hides notes. A Notion error never fails
  the build. Unchanged pages are reused from `node_modules/.cache/structura-notion`.
- Notes change on the next deploy. Test locally against a mock with `NOTION_API=<url>`.
- Writing back: once the notes are unlocked, each topic shows "Write a note". It's sealed
  with the notes key and sent to `/api/notion-note` (`netlify/functions/notion-note.mts`,
  logic in `netlify/lib/notion-save.ts`, `npm run test:notion`), which derives the same key
  from `NOTION_PASSPHRASE`, refuses anything that doesn't open or is over 5 minutes old,
  and appends it to *<root> / Notes from Structura / <topic title>*. Those pages come back
  into the app on the next build. The integration needs the "Insert content" capability.
- Never commit the token or generated notes, and never log note content.

## Studia accounts (Supabase)

**Studia** is the name of the family: Structura, Schemata and DSA Atlas. Its own repo, `studia`
(next to this one on the owner's GitHub), holds what they share: the Supabase migrations, the account contract (`docs/accounts.md`) and the setup steps. The plan is a
domain, `studia.dev`, with each app on a subdomain (`structura.studia.dev`, `schemata.studia.dev`,
`atlas.studia.dev`). `ECOSYSTEM_NAME` and `ECOSYSTEM_DOMAIN` are in `src/ecosystem.ts`; the app URLs
there stay on `netlify.app` until the domain is live.

- **Signing in is optional.** The account button (`src/account/AccountButton.tsx`) shows only when
  the build has Supabase settings. It signs in with GitHub (Supabase Auth, PKCE flow) and returns to
  the same page; `account.ts` tidies `?code=` away.
- **One session for every app.** `client.ts` keeps the session in a cookie named `studia-auth`. With
  `VITE_AUTH_COOKIE_DOMAIN=.studia.dev`, every subdomain reads the same cookie, so signing in once
  signs you in everywhere. On `*.netlify.app` it can't: browsers don't let one Netlify site set
  cookies for another, so each app signs in on its own until the move.
- **Progress sync.** The `structura:progress:v1` object (`src/learn/progress.ts`) is saved to the
  shared `app_progress` table, one row per user and app (`app = 'structura'`). Sync is
  read-merge-write (`account.ts`): fetch the account's copy, merge it with this device's
  (`merge.ts`), save the result in both places, 4 seconds after a change. Anything that only grows
  (sections read, lessons finished, best scores) is combined; switches that can be turned off
  (bookmarked, completed) come from the copy that changed that topic last (`updatedAt`). Other
  local settings (voice, code language, the notes key) are never synced.
- **Supabase stays out of start-up.** The client is a separate chunk, loaded only when the browser
  has a `studia-auth` cookie, is coming back from GitHub, or the learner taps "Continue with GitHub".
- **Settings** (Netlify environment variables, read at build time):
  `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (public by design: row-level security decides
  what each user may read or write) and, after the move, `VITE_AUTH_COOKIE_DOMAIN=.studia.dev`.
  Without the first two the account button is hidden and nothing is loaded.
- The table, its policies and the owner's setup steps (Supabase project, GitHub OAuth app, redirect
  URLs, Netlify variables, the move to `studia.dev`) are in the studia repo. The schema there is the
  source of truth for all three apps.
- Test the merge with `npm run test:sync`. To test the sign-in flow without a real project, build
  with a fake `VITE_SUPABASE_URL` and answer its requests in Playwright (`/auth/v1/authorize`
  redirects back with `?code=`, `/auth/v1/token` returns a session, `/rest/v1/app_progress` reads and
  upserts the row).

## Style

- **Simple English** for everything a learner reads (summaries, sections, walkthrough steps,
  takeaways, deep notes, lessons). Write for someone new to the topic whose first language may
  not be English:
  - Short sentences, one idea each (about 20 words at most). Say "you"; prefer active verbs.
  - Everyday words: "use", not "utilise"; "start", not "instantiate"; "split", not "partition"
    unless partition is the term being taught.
  - Keep the real term, and explain it in plain words the first time: "A hypervisor is software
    that splits one real server into several pretend computers."
  - Give one concrete example (a real command, a worked number, the food-delivery app) rather
    than another abstract sentence. No idioms or jokes that don't translate.
- Comments in code explain why, not what. Match the surrounding code style.
- Commit messages: conventional (`feat:`, `fix:`), imperative, one subject line.
