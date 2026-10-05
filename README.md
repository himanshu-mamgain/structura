# structura

Monorepo using npm workspaces.

| Path | Package | Stack |
| --- | --- | --- |
| `apps/web` | `@structura/web` | React, Vite, TypeScript, tldraw |
| `apps/server` | `@structura/server` | Node, TypeScript, Express |
| `packages/shared` | `@structura/shared` | Shared TypeScript types |

## Getting started

Requires Node 20+.

```sh
npm install
cp apps/server/.env.example apps/server/.env   # then set ANTHROPIC_API_KEY
npm run dev
```

- Web: http://localhost:5173 (proxies `/api` to the server)
- Server: http://localhost:3001 (set `PORT` to change)

## Voice design assistant

The panel in the bottom-right corner of the canvas lets you talk to Claude about your design.

1. Click the mic and speak (Chrome or Edge; other browsers can type instead).
2. The browser turns speech into text and sends it to `POST /api/assist` along with a screenshot of the canvas and the list of shapes.
3. The server streams Claude's reply back as server-sent events. The panel shows it as it arrives and reads each sentence aloud.
4. Any edits Claude proposes (move, resize, recolor, relabel, create, delete) are applied as one undoable step.

Each request carries only the current screenshot; earlier turns are sent as text, capped at the last 10 messages.

## PWA

The web app is installable and works offline (the assistant itself needs a connection). `vite-plugin-pwa` generates the service worker and manifest at build time; try it with `npm run build && npm run preview -w @structura/web`. App icons are generated from `apps/web/public/favicon.svg`; after changing it, run `npx pwa-assets-generator` in `apps/web`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs server and web in watch mode |
| `npm run build` | Builds every workspace |
| `npm run typecheck` | Type-checks every workspace |
| `npm start -w @structura/server` | Runs the built server |

Add a dependency to one workspace with `npm i <pkg> -w @structura/web`.
