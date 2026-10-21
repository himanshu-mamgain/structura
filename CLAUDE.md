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
- **Work on a branch and open a pull request. Never push to `main`.** Netlify
  makes a deploy preview for each PR; the owner reviews it on their phone and merges.
- **Respect source licences** (see "Sources" below). When in doubt, link, don't copy.
- Keep the mobile-first layout working: check anything visual at 390px wide too.

## Repo

npm workspaces, TypeScript 7, React 19, Vite 8.

- `apps/web`: the app.
  - `src/topics/`: one file per topic (`url-shortener.ts`, `twitter-timeline.ts`, …),
    registered in `src/topics/index.ts`. Types in `src/topics/types.ts`.
  - `src/topics/library.json`: the syllabus (generated, see below). `library.ts` reads it.
  - `src/shell/`: app shell. `App.tsx` (routes via `?topic=`, `?page=quiz|glossary`,
    `?library=`), `Home.tsx`, `TopicView.tsx`, `Practice.tsx`, `topicIcons.ts`.
  - `src/diagram/`: the 2D diagram (`Diagram2D.tsx`), box icons (`icons.ts`),
    component inspector logic (`inspect.ts`).
  - `src/board/`: the 3D city (`scene.ts`), ELK layout (`layout.ts`), load test panel.
  - `src/learn/`: content blocks, walkthrough, progress (localStorage), quiz/glossary data.
  - CSS: `index.css` (panel internals), `shell.css` (layout), `features.css` (newer features).
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
     celebrity fan-out switch in twitter-timeline). Set `explanation.trace` to
     `simulator.run(simulator.defaults)`.
   - `code`: up to 4 short, runnable snippets (`typescript`, `javascript`, `python`,
     `sql`, `go`, `java`, `bash`), with brief comments.
   - `takeaways`: 5 or 6 one-sentence points.
   - `guides`: related slugs from `library.json` (search it by title).
   - `adaptedFrom`: required when the topic is adapted from a CC BY source.
2. **Register it** in `src/topics/index.ts` (`STATIC_TOPICS`).
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
| [Apache Kafka](https://github.com/apache/kafka) docs | Apache 2.0 | May be adapted, with credit |
| [docker-curriculum](https://github.com/prakhar1989/docker-curriculum) | MIT | May be adapted, with credit |
| [awesome-system-design-resources](https://github.com/ashishps1/awesome-system-design-resources) | GPL-3.0 | **Link only**: copying would make Structura's code GPL |
| [kafka-nodejs-tutorial](https://github.com/billonline33/kafka-nodejs-tutorial) | none | Link only |

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

- **Topic videos (automatic):** every topic without a hand-made video gets one.
  After adding a topic: `npm run export:videos -w @structura/web`, then
  `npm run topics -w @structura/video` (voices, renders `public/videos/<id>.mp4`,
  makes the thumbnail and chapters, and registers it in `src/topics/videos.json`).
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

## Style

- Explanations: short, plain sentences; define a term the first time it appears.
- Comments in code explain why, not what. Match the surrounding code style.
- Commit messages: conventional (`feat:`, `fix:`), imperative, one subject line.
