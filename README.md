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
npm run dev
```

- Web: http://localhost:5173 (proxies `/api` to the server)
- Server: http://localhost:3001 (set `PORT` to change)

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs server and web in watch mode |
| `npm run build` | Builds every workspace |
| `npm run typecheck` | Type-checks every workspace |
| `npm start -w @structura/server` | Runs the built server |

Add a dependency to one workspace with `npm i <pkg> -w @structura/web`.
