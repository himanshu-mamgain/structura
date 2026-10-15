# Structura

**Learn system design by seeing it work.**

**Live app: [structura-web.netlify.app](https://structura-web.netlify.app/)**. Installable on Android, iOS and desktop, and works offline.

![A Structura topic: interactive diagram, narrated video with chapters, and explanation](apps/web/public/screenshots/wide-topic.png)

Every topic is a live architecture, not a static picture:

- **Interactive diagram.** Click any component to see what it does, what calls it and what it calls. Switch parts off (a cache, a server) and see which requests break.
- **Walkthrough.** Follow one real request step by step, with the actual request, cache entry or SQL at each step. Most topics let you try your own input.
- **3D load lab.** Switch the diagram to a three.js city and put real load on it with a discrete-event simulator (written in Rust, compiled to WebAssembly). Watch queues build and the bottleneck light up.
- **Narrated videos.** Short vertical explainers made with [Remotion](https://www.remotion.dev/), with chapters, resume, and save-for-offline.
- **Explanation, code and data model** for each topic, plus key takeaways and interview follow-ups.
- **Progress.** Bookmarks, completed topics, difficulty levels and an interview-readiness score, saved on your device.
- **Practice.** A quiz and a glossary.
- **Library.** Over 400 guides and chapters from open system design collections, searchable, as the syllabus for future topics.

Everything runs in the browser: no backend, no accounts, no AI calls.

## Topics

| Topic | Level | Video | Load test |
| --- | --- | :---: | :---: |
| URL Shortener | Beginner | ✓ | ✓ |
| Role-Based Access Control (RBAC) | Beginner | ✓ | ✓ |
| Docker vs Virtual Machines | Beginner | ✓ | |
| Uber Surge Pricing & Artificial Scarcity | Advanced | ✓ | |
| Twitter Timeline & Search | Intermediate | | |
| Web Crawler & Search | Intermediate | | |

## Getting started

Requires Node 20+. Rust is **not** needed: the compiled simulator is committed.

```sh
npm install
npm run dev
```

Open http://localhost:5173. To try it on a phone on the same Wi-Fi, open `http://<your-PC's-IP>:5173`.

## Repository

npm workspaces, TypeScript, React 19, Vite.

| Path | What it is |
| --- | --- |
| `apps/web` | The app (PWA): topics, 2D/3D diagrams, walkthroughs, progress, library |
| `apps/video` | Remotion videos with narration (`npm run studio -w @structura/video`) |
| `packages/shared` | Schemas for diagrams, data models, traces and explanations |
| `packages/sim` | Load simulator in Rust, compiled to WebAssembly (`pkg/` is committed) |

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the app with hot reload |
| `npm run build` | Builds every workspace |
| `npm run typecheck` | Type-checks every workspace |
| `npm run lan` | Builds and serves the production app on your network |
| `node apps/web/scripts/kb-sync.mjs` | Refreshes the library from its sources |
| `npm run voice -w @structura/video` | Generates narration with Windows' built-in voices |
| `npm run render -w @structura/video` | Renders the videos into `apps/web/public/videos` |
| `npm run build:wasm -w @structura/sim` | Rebuilds the simulator after changing its Rust code (needs Rust and wasm-pack) |

## Adding topics

Topics are TypeScript files in `apps/web/src/topics/`. [CLAUDE.md](CLAUDE.md) is the authoring guide: the structure, the conventions that make the inspector and walkthrough work, and the licensing rules. Claude Code (including [claude.ai/code](https://claude.ai/code)) reads it automatically, so a new topic can be requested in one sentence and arrives as a pull request with a Netlify preview.

## Deployment

Netlify builds `main` with `netlify.toml` (`npm run build -w @structura/web`, publishing `apps/web/dist`). The site is fully static.

## Credits and licences

Structura's code is MIT licensed ([LICENSE](LICENSE)). Content from other projects is used under their licences:

- **[System Design Primer](https://github.com/donnemartin/system-design-primer)** by Donne Martin, CC BY 4.0. The Twitter Timeline and Web Crawler topics are adapted from it; each topic page credits it.
- **[System Design 101 course](https://github.com/mominurr/system-design-101)** by Mominur Rahman, MIT. The quiz and glossary; notice in [`apps/web/public/licenses`](apps/web/public/licenses).
- **[ByteByteGo System Design 101](https://github.com/ByteByteGoHq/system-design-101)**, CC BY-NC-ND 4.0. Titles and links only, in the library.
- **[System design diagrams](https://github.com/Chaki34/system-design-diagrams)** by Chaki34. Linked only.
