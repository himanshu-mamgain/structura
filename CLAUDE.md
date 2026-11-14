# Structura

A PWA for learning system design by seeing it work. Each topic is an interactive
architecture (2D diagram + three.js 3D city), a step-by-step walkthrough with a
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
  - `src/shell/`: app shell. `App.tsx` (routes via `?topic=`, `?page=explore|reels|listen|quiz|glossary|roadmap`,
    `?page=reels&reel=<id>`, `?library=`; the five Instagram-style tabs, along the bottom on
    phones and in the top bar from 1024px), `Home.tsx` (reels row first), `Explore.tsx`
    (search, topic grid, library), `Reels.tsx` (full-screen video feed), `Search.tsx`,
    `TopicView.tsx`, `Practice.tsx`, `Roadmap.tsx` (where to start: the parts in
    `src/learn/roadmap.ts`, step by step), `topicIcons.ts`. There's no sidebar: anything fixed
    to the bottom of the screen sits above the tab bar (`bottom: calc(… + var(--tabbar))`).
  - `src/diagram/`: the 2D diagram (`Diagram2D.tsx`), box icons (`icons.ts`),
    component inspector logic (`inspect.ts`).
  - `src/board/`: the 3D city (`scene.ts`), ELK layout (`layout.ts`), load test panel.
  - `src/learn/`: content blocks, walkthrough, progress (localStorage), quiz/glossary data.
  - CSS: `index.css` (panel internals), `shell.css` (layout), `features.css` (newer features).
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
   - `code`: up to 4 short, runnable snippets (`typescript`, `javascript`, `python`,
     `sql`, `go`, `java`, `bash`), with brief comments.
   - `takeaways`: 5 or 6 one-sentence points.
   - `guides`: related slugs from `library.json` (search it by title).
   - `adaptedFrom`: required when the topic is adapted from a CC BY source.
   - **Deep notes** (`src/topics/notes/<id>.md`, recommended): the article read mode shows
     instead of the explanation, written like the owner's Notion study notes. `# Title`, then a
     `> 💡 **TL;DR**` callout, then `##` sections: an at-a-glance table, how it works underneath,
     real code, a "How to choose" guide, `## ⚠️ Critical Mistakes`, `## Interview Q&As`
     (`**Q: …**` then `A: …`), related topics (`/?topic=<id>&read` links), sources and
     `## Why This Matters`. `docker-vs-vm.md` is the model; `src/learn/markdown.ts` lists the
     Markdown it reads (tables, code fences, callouts, nested lists).
2. **Register it** in `src/topics/index.ts` (`STATIC_TOPICS`), **give it an area** in `AREA_OF`
   (`src/topics/areas.ts`: `development`, `infra`, `databases` or `ai`; the build stops without one),
   and **give it a step in the roadmap** (`src/learn/roadmap.ts`) in a part of the same area. Unplaced
   topics still show, at the end of their area, under "More topics".
3. **Pick an icon** in `src/shell/topicIcons.ts` (any `lucide-react` icon).
4. **Check** `npm run typecheck` and `npm run build -w @structura/web`.
5. **Make its video and audio lesson** (see below) if the Kokoro setup is available.
6. **Open a PR** titled `feat: add <title> topic`, saying what the walkthrough and
   simulator show and which source it is based on (with licence).

Numbers in examples must be correct: compute them (base62 codes, capacity
estimates, hashes) rather than guessing. Use realistic example data.

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

## Style

- Explanations: short, plain sentences; define a term the first time it appears.
- Comments in code explain why, not what. Match the surrounding code style.
- Commit messages: conventional (`feat:`, `fix:`), imperative, one subject line.
