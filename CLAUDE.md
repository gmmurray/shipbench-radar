# CLAUDE.md

Radar is a private, local app that shows several ShipBench boards in one
browser window, one tab per registered repository. It is built for one
developer and is not distributed.

[DESIGN.md](DESIGN.md) is the source of truth for scope, decisions, and the
build order. Its "v1 plan" section lists the milestones (M0–M3) with
acceptance criteria. Read it before proposing structure, and update it in the
same change when a decision moves. Don't let the code and the design drift
apart silently.

## Commands

```sh
pnpm dev          # server (node --watch, --dev) + Vite on http://127.0.0.1:5173
pnpm build        # Vite build of the web app to dist/web
pnpm start        # build, then serve everything on http://127.0.0.1:4747
pnpm radar <cmd>  # registry CLI (M3)
pnpm typecheck    # server/CLI config, then src/web/tsconfig.json
pnpm lint         # Biome
pnpm check        # Biome format + lint + organize imports, writing fixes
pnpm test         # Vitest
```

Run `pnpm check`, `pnpm typecheck`, and `pnpm test` before calling work done.

To try Radar without touching your real registry, point `RADAR_HOME` at a
scratch directory holding a `registry.json`, and `RADAR_PORT` at a spare port.
The user often has their own `pnpm dev` running on 4747 and 5173, against
the real registry. For agent-run checks, use other ports: a spare
`RADAR_PORT`, and `vite --port <n>` in place of `pnpm dev`. Stop only the
processes you started, and find them by port. Don't use `timeout pnpm dev`
from Git Bash, which can leave the Node children running on Windows.

[registry.example.json](registry.example.json) is the maintained sample
registry, the equivalent of an `.env.example` file. When the registry format
changes, update it in the same change. `registry.test.ts` loads it through
the real parser.

## Layout

- `src/server/` — the HTTP server. Node runs these `.ts` files directly
  (type stripping), with no build step: only erasable syntax (no enums, no
  parameter properties), and relative imports keep their `.ts` extension.
- `src/cli/` — the `pnpm radar` registry command. Same rules as the server.
- `src/shared/` — type-only declarations used by both the server and the web
  app (e.g. the `/api/projects` response). No runtime imports.
- `src/web/` — the React app, bundled by Vite, with its own
  `tsconfig.json`. Import only types from the `@shipbench/core` barrel here.
  Its adapters import `node:fs` and break the browser build, and Biome
  rejects them.
- Tests sit next to the code as `*.test.ts(x)`.

## Related repositories

- `../shipbench` — ShipBench itself (pnpm monorepo). Radar consumes the
  published `@shipbench/core` and `@shipbench/board` packages from npm,
  pinned to an exact version, never through a workspace link. Resolving from
  npm is part of the point (see DESIGN.md, "Why it lives outside the
  ShipBench repository").
  - `apps/cli/src/boardServer.ts` — the request handler Radar's API mirrors.
  - `apps/cli/src/tui/watch.ts` — the watcher pattern to reproduce.
  - `packages/board/src/standalone.tsx` — the CLI's `BoardAPI`, the model for
    Radar's per-project one.
- `../shipbench-harbor` — the other external host of the board. It answers
  "what is on `main`" through GitHub; Radar answers "what is on disk now".

ShipBench changes go through that repo's normal process, because it is a
public package. When Radar work turns up a ShipBench bug or improvement,
don't patch `../shipbench` from here. Write it up for the user to file, and
record it under "Pending upstream" in DESIGN.md if Radar depends on it.

## Invariants

- Radar stores no tasks. All board writes go through `FsAdapter` into the
  registered repository's own `.shipbench/`.
- One server process, one `FsAdapter` per project, routed by project key
  under `/api/projects/:key/...`. No child processes or per-project ports.
- Mount only the active project's board, until the upstream key-handler fix
  ships (DESIGN.md, "Mounting").
- One multiplexed SSE stream for all projects, never one per project, because
  of the browser's six-connection-per-origin limit. The browser side shares
  one `EventSource` (`src/web/events.ts`).
- `src/web/radar.css` overrides five of the board's viewport-sized rules so
  it fits under the tab bar. They depend on `@shipbench/board`'s class
  names: when bumping the board, re-check them in a browser (short board
  with no page scroll, long board with pinned tab bar and header, detail
  sidebar).
- The server binds `127.0.0.1` on a fixed port and rejects requests with a bad
  `Host`/`Origin` or a non-JSON write (DESIGN.md, "The local server").
- Registry entries are declarations; derived data goes in a separate,
  deletable cache file. UI preferences sit beside entries, not inside them.

## Environment

Windows, with PowerShell and Git Bash both available. Config lives in
`%APPDATA%\radar` (`RADAR_HOME` overrides it). Registry paths are
machine-local absolute paths.
