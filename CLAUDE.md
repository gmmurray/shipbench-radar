# CLAUDE.md

Radar is a personal, local app that shows several ShipBench boards in one
browser window, one tab per registered repository. It is built for one
developer. The repository is public, but Radar is not packaged, published,
or supported. Don't commit anything machine-specific beyond the sample
paths already in the docs: no real registry, and no scratch or test output.

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
pnpm console      # quiet build, then serve with single-key commands (o/q/h)
pnpm shortcut     # desktop shortcut to scripts\radar.cmd, which runs `console`
pnpm radar add <path> [--key k] [--id id]   # register a project
pnpm radar move <key> <path>                # repair a moved repository
pnpm radar list                             # entries (tab order) and availability
pnpm radar remove <key>                     # unregister (repo untouched)
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

Console mode's key handling needs a real console (raw-mode stdin), which
agent shells don't have. To exercise it, launch `scripts\radar.cmd` in a
hidden window and write key events into that console with
`AttachConsole` + `WriteConsoleInput`. Never use SendKeys, which types into
whatever window has focus. Don't send `o` in tests: it opens a tab in the
user's real browser.

[registry.example.json](registry.example.json) is the maintained sample
registry, the equivalent of an `.env.example` file. When the registry format
changes, update it in the same change. `registry.test.ts` loads it through
the real parser.

## Layout

- `src/server/` — the HTTP server. Node runs these `.ts` files directly
  (type stripping), with no build step: only erasable syntax (no enums, no
  parameter properties), and relative imports keep their `.ts` extension.
- `src/cli/` — the `pnpm radar` registry command. Same rules as the server.
  The logic is `runCli()` in `commands.ts`, which tests call directly; `radar.ts`
  only wires in the process. Relative paths resolve from `INIT_CWD`, because
  pnpm runs scripts from the package directory.
- `src/shared/` — type-only declarations used by both the server and the web
  app (e.g. the `/api/projects` response). No runtime imports.
- `src/server/registration.ts` — the rules for adding and repairing
  entries, shared by the CLI and the registry API (`registryApi.ts`). Change
  a rule there, never in only one caller.
- `src/web/ProjectsPage.tsx` — the Projects page (`#/_projects`): tab order,
  repair, remove, add with preview and suggestions.
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
- Boards stay mounted once opened; inactive ones are hidden with the `hidden`
  attribute, never `visibility` or off-screen positioning. The board
  (0.6.0+) skips keyboard shortcuts only for boards hidden by `hidden` or
  `display: none`. Only the visible board gets `documentTitle`. See
  DESIGN.md, "Mounting".
- One multiplexed SSE stream for all projects, never one per project, because
  of the browser's six-connection-per-origin limit. The browser side shares
  one `EventSource` (`src/web/events.ts`).
- The board fits under the tab bar through its own sizing variables,
  `--sb-viewport-h` and `--sb-sticky-top`, set on `.radar-board` in
  `src/web/radar.css`. Never override the board's rules by class name.
  After bumping the board, still check it in a browser: a short board with
  no page scroll, a long board with the tab bar and header pinned, the
  detail sidebar, and a task left open on a hidden board.
- The server binds `127.0.0.1` on a fixed port and rejects requests with a bad
  `Host`/`Origin` or a non-JSON write (DESIGN.md, "The local server").
- Registry entries are declarations; derived data goes in a separate,
  deletable cache file. UI preferences sit beside entries, not inside them.
- Registry writes go through `src/server/registryFile.ts` (`editRegistry`):
  edit the raw JSON (never re-serialize the parsed form, which drops unknown
  fields), validate with `parseRegistry`, and land by rename. The server
  learns about changes only by re-reading the file. Its watcher does that,
  and the registry API triggers the same reload after its own writes so its
  response is current.
- Tab order lives in `ui.order` and is applied by `inTabOrder()`. Anything
  that lists projects to the user uses it, not raw registry order.
- Tests that need a live server use `startRadar({ port: 0, ... })` and the
  helpers in `src/server/testSupport.ts`.

## Environment

Windows, with PowerShell and Git Bash both available. Config lives in
`%APPDATA%\radar` (`RADAR_HOME` overrides it). Registry paths are
machine-local absolute paths.
