# Structura

A PWA for learning system design by seeing it work. Each topic is an interactive
architecture (2D diagram + three.js 3D city), a step-by-step walkthrough with a
"try your own input" simulator, an explanation, code, a data model, key
takeaways and (for some) a narrated Remotion video. Deployed to Netlify as a
static site from `main`: https://structura-web.netlify.app

## Hard rules

- **No AI and no backend at runtime.** Everything runs in the browser. Don't add
  API calls, servers, API keys or LLM features to the app. (`apps/server` was
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
node apps/web/scripts/kb-sync.mjs  # refresh library.json from the sources
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
5. **Open a PR** titled `feat: add <title> topic`, saying what the walkthrough and
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

Otherwise, write topics from your own knowledge. The library (`library.json`)
is the syllabus: topics not yet built are good candidates.

## Videos

Narration is generated with Windows' built-in voices (`apps/video/scripts/voice.mjs`
uses PowerShell), so **videos can't be made in a cloud session**. Add topics
without `video`/`chapters`; the owner renders videos locally:

```bash
npm run voice -w @structura/video -- <video-id>   # Windows only
npm run render:<name> -w @structura/video          # writes apps/web/public/videos/<id>.mp4
npm run thumbs -w @structura/video                 # poster images
cd apps/video && npx tsx scripts/chapters.ts       # chapter start times (add the video to its list first)
```

## Style

- Explanations: short, plain sentences; define a term the first time it appears.
- Comments in code explain why, not what. Match the surrounding code style.
- Commit messages: conventional (`feat:`, `fix:`), imperative, one subject line.
