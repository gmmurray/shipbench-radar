# Radar — design notes

Status: M0–M2 done 2026-09-23; see "v1 plan". Written 2026-09-21 against
ShipBench `core` / `board` / `cli` at 0.4.0; revised 2026-09-23 after reading
the board, core, and CLI source for the questions in the mounting, event,
version-skew, and local-server sections.

The name is a placeholder. It sits next to `shipbench-harbor` in
`Q:/code/personal/`, which is why the directory carries the `shipbench-`
prefix while the product name is just Radar — the same split Harbor uses.

## What it is

A local, personal app that presents several ShipBench boards in one window,
switched by tab. Each registered repository keeps its own `.shipbench/`
directory and remains independently usable; Radar is one more client for
boards that already exist, in the same sense that the CLI and Harbor are.

It is a private tool. It is not distributed, not published, and not built for
a general audience. That is deliberate and is the reason it can be shaped
around one developer's actual working habits instead of a hypothetical user's.

## The friction it answers

Several projects are under active development at once, each with its own
`.shipbench/` board, several with coding agents working in them. Opening a
board means running `shipbench board` from that project's directory, which
starts a server on its own port, and then finding the right port again later.
The current workaround is one pinned VS Code browser tab per project, which
holds the last port it used, so the same project tends to land on the same
port. It works. The cost is not in any single board — it is in moving between
them.

This is a navigation problem, not a data-aggregation problem. Radar does not
need to merge boards, reconcile differing column sets, or answer questions
across projects to be worth building. Those are separate ideas with separate
arguments, tracked in the ShipBench repository's local-workbench spike.

## Why it lives outside the ShipBench repository

Two reasons, both load-bearing.

It is customized for one person, so keeping it private removes any obligation
to generalize a decision before there is evidence for it.

It also becomes the second external consumer of `@shipbench/core` and
`@shipbench/board` after Harbor. An export that only resolves through a
workspace link fails in an ordinary `npm install` here immediately, which is
the kind of pressure a published contract only gets from a real outside host.

## Architecture: one process, many adapters

**Decision: a single local server holding one `FsAdapter` per registered
repository, routing on a project id, with the board mounted as a library
component.** No per-project servers, no per-project ports, no child processes.

Roughly:

- One HTTP server. Project routes shaped `/api/projects/:key/...`, so
  app-wide routes like `/api/events` can never collide with a project key.
- Per registered project, `new FsAdapter(absolutePathToRepo)`.
- The API layer delegates to `@shipbench/core` — `loadConfig`, `listTasks`,
  `listArchivedTasks`, `createTask`, `updateTask`, `reorderTask`, `addComment`,
  `editComment`, `deleteComment`, `archiveTask`, `unarchiveTask`, `deleteTask`.
  It is transcribable almost directly from
  `../shipbench/apps/cli/src/boardServer.ts` (see the request handler at
  roughly lines 236-400). Nothing is invented; it is delegation.
- Frontend mounts `createBoard(el, { api })` from `@shipbench/board` for the
  active project only (see "Mounting: one board at a time"), with a `BoardAPI`
  whose fetches carry the project id.
- One chokidar watcher per project, following the pattern in
  `../shipbench/apps/cli/src/tui/watch.ts` — the tasks directory plus
  `config.json` and `layout.json`, filtered to `.md` and those two files,
  150 ms debounce. That module is not exported from the CLI package; it is
  about thirty lines to reproduce.
- **One** server-sent event stream for the whole app, each event carrying its
  project id. Not one stream per project: browsers cap HTTP/1.1 at six
  connections per origin, and each open `EventSource` holds one for good. Six
  registered projects with a stream each would leave no connection for the
  board's own fetches, and the page would hang. The tab bar reads every
  event; the mounted board's `onTasksChanged` filters the same stream to its
  own project id.

**Rejected alternative: a launcher that spawns `shipbench board` per project
and shows each in an iframe tab.** It works — the board server sets no
`X-Frame-Options` and no `frame-ancestors`, so iframing one localhost origin
from another renders fine — and it is perhaps a third of the work. It was
rejected because every board stays a sealed box in a separate process, so
nothing that spans projects is reachable later, and because it automates the
spin-up step rather than removing it. The button-to-start-a-board interaction
is an artifact of the per-port architecture; the chosen shape deletes the need
for it. Every registered repository has a live adapter from startup, and
switching costs a click with no port, no child process, and no cold start.

## What the published packages already provide

Verified against the ShipBench repository at 0.4.0:

- `createBoardRequestHandler(adapter, bundleDir, warn)` in the CLI holds no
  module-global state, so N boards in one process needs no contortion. It is
  the model to copy, not an import — the `shipbench` npm package ships only a
  `bin` and declares no `exports`, so nothing in it is importable.
- `@shipbench/board` publishes a real host entry:
  `createBoard(element, { api, themeControl, documentTitle })`, with
  `./styles.css` exported alongside. `documentTitle` names the browser tab
  from `config.name`, which was added for exactly this multi-project case.
- `@shipbench/core` publishes `FsAdapter` and every function the board API
  calls, plus the `BoardAPI` type the board expects.
- The board's library entry deliberately does not import fonts — hosts load
  their own. IBM Plex Sans and Intel One Mono are needed. React 19 and
  React DOM 19 are peer dependencies.
- Live updates go through the host. The board subscribes via the optional
  `BoardAPI.onTasksChanged(callback) => unsubscribe`; it opens no
  `EventSource` of its own. With the method absent it falls back to a
  60-second poll. Radar implements the method.
- Board state is per instance. Each `createBoard` builds its own zustand store
  inside `BoardStoreProvider`, so two boards never share selection or data.

One constraint that rules out a cheaper design: the shipped standalone bundle
hardcodes root-absolute `/api/...` paths. The hardcoding lives only in
`packages/board/src/standalone.tsx`, which is the CLI's `BoardAPI`; the library
entry is path-agnostic. The published board *app* therefore cannot be
multiplexed under path prefixes such as `/board/foo/`. It is one origin per
board, or the host owns the shell. Radar owns the shell.

## Mounting: one board at a time

**Decision: only the active tab's board is mounted. Switching tabs unmounts
the old board and mounts the new one.**

Radar is a React app itself, so it renders the package's exported `Board`
component with `key={projectKey}` rather than calling `createBoard`, which
would create a second React root. Changing the key is the unmount. `Board`
takes the same `api` / `themeControl` / `documentTitle` props that
`createBoard` forwards to it.

Keeping every board mounted and hiding the inactive ones does not work with
the board as published. Two components attach `keydown` listeners to `window`
rather than to their own subtree:

- `BoardCanvas` — Escape closes the archive view or deselects the task.
- `DetailView` — `j`/`k`/ArrowUp/ArrowDown step through the column, with
  `preventDefault`.

A hidden board would still receive every keystroke. Escape on the visible
board would also close the detail views of the hidden ones, and a hidden board
with a task open would take over the arrow keys.

Unmounting costs one `getConfig` + `listTasks` round trip to a local server
per switch, which is milliseconds. It also loses the in-board view state (open
task, archive view) on switch. That is accepted for now. Nothing lets a host
set the selected task, so Radar could not restore it anyway.

Consequences of mounting one board at a time:

- `documentTitle: true` is safe. Only one board sets the title, and its
  unmount cleanup restores the previous title.
- `themeControl` stays off. The toggle writes `data-theme` on `<html>` and
  `sb-theme` in `localStorage`, both page-global. Radar owns the theme and
  sets `data-theme` on `<html>` itself; the board's CSS reads it from there,
  as it does under Harbor.
- Radar's own writes can only touch the active project, so they never mark a
  tab changed. The unread indicator reflects outside writes (agents, the CLI,
  an editor) without needing to tell writers apart.

If keeping boards alive turns out to matter, the fix belongs upstream, and it
is not to move the listeners onto the board's root element. Key events only
reach an element that holds focus, so the standalone board would ignore
Escape and `j`/`k` whenever focus sits on `<body>`, for example after a fresh
load. The fix is a visibility gate: keep listening on `window`, but have each
handler return early when its own root is not rendered
(`root.getClientRects().length === 0`, true under `display: none`), ideally
through one shared `useBoardKeydown` hook. That needs no API change, leaves
standalone and Harbor unchanged, and lets a host keep hidden boards mounted
just by hiding them. The rest of the board already tolerates several
instances: `--sb-header-h` is set on each board's own root, and a hidden
board's toaster renders inside a hidden tree. With that fix upstream, Radar
would switch to keeping boards mounted, which makes switching instant and
keeps each tab's open task.

## Writes go straight to each repository

`FsAdapter` is plain `fs.writeFile` rooted at the path it was constructed
with. A board action in Radar rewrites the real `.md` file and `layout.json`
inside that repository, and `git status` there reflects it immediately. This
is byte-for-byte what `shipbench board` does in that directory; the only
difference is which process holds the adapter. Radar stores no tasks of its
own, and that is not an implementation convenience — it is ShipBench's central
invariant.

## Concurrency

Writes are whole-file with no locking. Last write wins. This exposure exists
today with a single board open; Radar multiplies it, because the natural way
to use it is to leave every board open beside agents working in those repos.

- Task files are the mild case. Collisions require the same task in the same
  moment, and the watcher re-reads after any external write.
- `layout.json` is the sharp edge. One file holds every column's ordering, so
  a drag in Radar racing an agent's `task move` loses the whole layout delta
  rather than one field.

Not a blocker, and not a reason to make Radar read-only. It is a known cost of
having many boards live at once, recorded here so it is not rediscovered as a
bug.

**Decision: Radar does not detect or refuse a concurrent `shipbench board`
server.** The CLI writes no lockfile or pidfile, and it picks the first free
port from its preferred one, so there is nothing reliable to detect. A second
writer on the same repository is the same last-write-wins exposure as an
agent, and is accepted on the same terms.

### Version skew

Radar pins one `@shipbench/core`. Each repository is also written by whatever
`shipbench` version its agents run. Reading core at 0.4.0, the failure mode is
mild:

- Unknown task frontmatter fields are preserved on write (updates spread the
  existing frontmatter) and reported as "Unknown frontmatter field …
  (preserved)" warnings.
- `config.json` is round-tripped as raw JSON when core touches it, so unknown
  config keys survive.

The real risk is semantic, not destructive: an older core ignores the meaning
of a newer field, or applies an older layout rule. Keep Radar's core at or
ahead of the newest CLI in use, and bump it whenever the CLI is bumped.

## The local server

One process now has write access to every registered repository, where a
`shipbench board` server could reach only one. That raises the stakes of a
gap the CLI server already has. It binds `127.0.0.1`, but it accepts a request
body as JSON whatever its `content-type`, and it checks neither `Host` nor
`Origin`. Any web page open in the browser can therefore send a no-preflight
`text/plain` POST to a localhost port and create or archive a task. A DNS
rebinding attack could also read the board.

Radar closes that gap in its own server rather than copying it:

- Bind `127.0.0.1` only.
- Reject any request whose `Host` is not `127.0.0.1:<port>` or
  `localhost:<port>` (defeats DNS rebinding).
- Reject any non-GET request whose `content-type` is not `application/json`.
  That forces a CORS preflight, and Radar never answers one, so no
  cross-origin page can write.
- Reject any request with an `Origin` header that is not Radar's own.

## The project registry

Radar needs a list of projects. The ShipBench local-workbench spike has
already settled the design questions that list raises, and its conclusions are
adopted here rather than re-derived.

**Shape — adopted from the spike.** An entry stores *identity* and *location*
as two separate things: portable identity that travels with the project (a
normalized Git remote URL, or a locally declared fallback id for a repository
with no remote) and a machine-local absolute path. Storing both is what lets a
stale entry report that a specific named project is missing instead of
resolving to nothing — or, worse, resolving to a real but different directory.

**Location — deliberately not the canonical one.** The registry lives under
Radar's own config directory, never at `~/.shipbench/`. A ShipBench registry
would be that project's first piece of machine-global state, and where it
belongs is genuinely open there: one identical path on every platform versus
per-platform config directories, with dotfile syncing able to carry a registry
to a machine where its paths are wrong. Squatting the canonical address would
answer that question by accident. Keeping Radar's registry at a private
address keeps the format cheap to churn, and promoting it later is a file
copy.

**The registry is declarations, not cache.** Entries are authoritative and are
meant to be precious. Anything derived — last-changed timestamps, a search
index, computed board summaries — goes in a separate file that can be deleted
at any moment and rebuilt. The temptation to blur this comes from wanting the
tab bar to render instantly; resist it there specifically.

**Keep UI state out of the entries.** Tab order, colors, pinning, and similar
preferences are Radar's and may live in the same file, but beside the project
entries rather than inside them, so the part that might generalize later is
not carrying one person's interface state.

**A registry grants no access.** Where an agent's filesystem reach is
restricted, a registered path is blocked exactly as a guessed one is.
Registration solves discovery and naming. It is not a sandboxing mechanism and
must not be argued for as one.

## Interface

Tabs, not a wall of boards. Several boards visible at once is not the goal;
moving between them quickly is.

The tab bar listens to the shared event stream and marks the projects that
changed while attention was elsewhere. With agents working in several repos,
that indicator is likely the most useful thing Radar does, and it is close to
free — every event on the shared stream already names the project that
changed.

Unread markers are in-memory for now: a restart clears them. If they need to
survive restarts, the last-seen state is derived data and goes in the cache
file, never in the registry.

Electron is not required. A local page in a pinned browser tab is the same
experience with none of the packaging.

## Stack

Decided 2026-09-23. Chosen to match ShipBench's tooling, so habits and config
carry over.

- **Runtime:** Node 24, ESM, TypeScript. Node runs the server's `.ts` files
  directly through its built-in type stripping, with no build step for the
  server. The server tsconfig sets `erasableSyntaxOnly` so no syntax that
  stripping can't handle (enums, parameter properties) creeps in, and
  relative imports use `.ts` extensions.
- **Server:** `node:http` with no framework. The code mirrored from
  `boardServer.ts` is already written against it, and the route count is
  small.
- **Watching:** chokidar, as in the CLI.
- **Frontend:** React 19 and Vite. React is required by the board anyway, so
  the tab bar is React too. In dev, Vite serves the page and forwards `/api`
  to the server. In normal use, the server serves Vite's build output.
- **Styling:** plain CSS on the board's `--sb-*` tokens. The published
  `@shipbench/board/styles.css` is compiled Tailwind, so Radar needs no
  Tailwind. That file includes Tailwind's page-wide reset, which the tab bar
  inherits.
- **Fonts:** `@fontsource/ibm-plex-sans` and `@fontsource/intel-one-mono`,
  loaded by Radar because the board's library entry doesn't load them.
- **Tooling:** pnpm, Biome, Vitest. One package, not a monorepo:
  `src/server/`, `src/web/`, `src/cli/`.

## v1 plan

Milestones in build order. Each is done when its acceptance items hold.

### M0 — Skeleton

Tooling only: package manifest, tsconfigs, Biome, Vitest, Vite config, empty
entry points. **Done when** `pnpm typecheck`, `pnpm lint`, and `pnpm test`
pass on the empty project, and `pnpm dev` serves a blank page.

### M1 — One board, served safely

- **Config directory:** `%APPDATA%\radar` on Windows, `$XDG_CONFIG_HOME/radar`
  (falling back to `~/.config/radar`) elsewhere. The `RADAR_HOME` environment
  variable overrides it, which tests use.
- **Registry:** `<config dir>/registry.json`, edited by hand until M3.
  [`registry.example.json`](registry.example.json) at the repository root
  is the maintained sample: copy it to start, and update it whenever the
  format changes. A test loads it through the real parser, so it can't
  silently go stale.

  `key` is Radar's short local handle, used in URLs: lowercase letters,
  digits, and hyphens, unique. `id` is the portable identity, unique: a
  normalized GitHub remote (`github.com/<owner>/<repo>`), or any declared
  fallback such as `local/<name>` for a repository with no remote. `path` is
  the machine-local location, absolute. Identity and location are kept
  separate as described in "The project registry". `ui` holds interface
  preferences, kept beside the entries rather than inside them. A missing registry file is an empty registry, since the
  first run has nothing registered. An unparseable or invalid registry fails
  startup with a message naming every problem. An entry whose path is missing
  or isn't an initialized ShipBench project loads as *unavailable* instead of
  being dropped. Availability is checked per request with core's
  `inspectProjectInitialization`, so a repository that comes back becomes
  available without a restart.
- **Server:** listens on `127.0.0.1:4747` (`RADAR_PORT` overrides). A fixed
  port, unlike the CLI's count-upward search: a pinned tab depends on the URL
  staying the same, so a port already in use fails startup loudly.
  - `GET /api/projects` — each entry's key, id, name (from `config.name`), and
    whether it is available.
  - `/api/projects/:key/...` — the CLI's board API routes, delegating to core
    through that project's `FsAdapter`.
  - Every other path serves the built web app.
  - The request checks from "The local server". The allowed `Origin` values
    are the server's own origin plus, under `--dev` (which `pnpm dev`
    passes), Vite's. Vite's proxy rewrites `Host`, so the Host check holds
    in dev too. Radar's `BoardAPI` sends `application/json` on every write,
    bodiless ones included.
- **Web:** fetches the project list and mounts the board for the project
  named in the URL hash, else the first available one, using a `BoardAPI`
  whose paths carry the project key. Unavailable and unknown projects render
  a notice with the reason.
- **Done when:** a board action in Radar changes the repository's files
  exactly as `shipbench board` would. Tests cover each request-check
  rejection. An unavailable project shows an error state, not a crash.

### M2 — Tabs and live updates

Done 2026-09-23. As built:

- One watcher per project whose directory exists at startup, reproducing
  the CLI's. A project that is unavailable at startup gets no live updates
  until Radar restarts (M3's registry reconciling is the natural place to
  lift that).
- `GET /api/events`: one stream for all projects. Each event is
  `tasks-changed` with `{"project": "<key>"}`, and a comment heartbeat every
  25 s keeps idle connections and Vite's proxy open. In the browser, one
  `EventSource` is shared by the tab bar and the mounted board, whose
  `onTasksChanged` filters it to its own key.
- Tab bar: a sticky row of links, one per registry entry in registry order.
  Each link's `href` is its hash (`#/shipbench`), so clicking, reloading, and
  pinning all go through the one mechanism M1 built. The label is
  `config.name`, falling back to the key. Unavailable projects are
  struck through, with the reason in the tooltip and on the page.
- Unread markers: a dot on any tab whose project changed while another was
  on screen, cleared on viewing. Kept in memory, per "Interface". Any event
  also re-reads the project list, as does the browser tab becoming visible
  again, so names and availability stay current.
- Layout: the board sizes itself to the viewport, so Radar corrects five of
  its rules from `radar.css` by `--radar-tabs-h`: root `min-height`, header
  `top`, canvas and kanban `min-height`, and the detail sidebar's `top` and
  `max-height`. The board's rules sit in `@layer utilities` and Radar's are
  unlayered, so Radar's win outright. These overrides depend on board 0.4.0's
  class names, so re-check them on every board upgrade. The durable fix is
  upstream (see "Pending upstream").
- Theme: no `data-theme` on `<html>`, so the board follows the OS setting.
  A toggle can come later.
- **Verified** in Chromium with nine projects registered. A real `shipbench
  task move` in one project marked its tab while another was viewed. A CLI
  write to the viewed project appeared in about 300 ms, with no poll
  involved. Seven tab switches in a row each loaded in about 110 ms over
  one event stream. A short board didn't scroll the page, and on a long one
  the tab bar and board header stayed pinned. Both themes were checked.

### M3 — Registration

A small command, run as `pnpm radar <command>`:

- `add <path> [--key <key>] [--id <id>]`. The path must contain
  `.shipbench/config.json`. The identity comes from the `origin` remote via
  core's `parseGithubRemoteUrl`, normalized to `github.com/<owner>/<repo>` in
  lowercase. A repository with no GitHub `origin` requires `--id`. The key
  defaults to the repository name. A duplicate key or identity is rejected.
- `list` shows each entry and whether its path is still available.
- `remove <key>`.

The server watches `registry.json` and reconciles adapters and watchers
without a restart.

**Done when:** adding, listing, and removing projects needs no hand-editing,
and a running Radar picks up each change on its own.

### After v1

Keep boards mounted once the upstream key-handler fix is released. A theme
toggle. An in-app registry editor. Starting at login.

## Non-goals

- Distribution, publishing, or a general audience.
- Storing tasks. Every board's tasks stay in its repository.
- Merging boards into one view, or reconciling differing column sets.
- Cross-project search, or any cross-project index. A separate question with
  its own argument, currently open in the ShipBench spike.
- Cross-repository task dependencies, and cross-project references in task
  frontmatter. Ruled out in the spike: a committed reference resolvable only
  through an unversioned local registry would break the invariant that a
  repository's `.shipbench/` is self-contained.
- Automatic project discovery. Registration is explicit.
- Anything Harbor is for. Harbor answers what is on `main` across projects
  through the GitHub API; Radar answers what is on disk right now.

## What might flow back to ShipBench, in order of likely value

1. **Registry answers.** Canonical checkout selection, duplicate worktrees,
   inaccessible projects, and identity for repositories with no remote are
   listed as open in the spike and cannot be settled by reasoning. Six real
   projects registered for a few weeks settles them. This arrives whether or
   not a line of code is ever generalized.
2. **Evidence for a library export.** If one process hosting many adapters
   holds up, that is an argument for the CLI exposing its board handler as an
   importable module rather than bin-only. Evidence first.
3. **Small upstream fixes found along the way.** Building Radar keeps
   turning up small ShipBench bugs and improvements. File them in ShipBench
   through its normal process as they come up, and track any that affect
   Radar under "Pending upstream".
4. **Nothing about the interface.** Tab design, layout, and personal tuning
   stay here. That is the point of building it privately.

## Pending upstream

Filed in ShipBench 2026-09-23. None of these blocks building Radar.

- **Board key handlers ignore hidden boards** (needs an `@shipbench/board`
  release). Until it ships, Radar unmounts inactive boards. Once it does,
  switch to keeping every board mounted and hiding inactive ones (see
  "Mounting").
- **CLI board server `Host`/`Origin` checks.** Radar doesn't use the CLI
  server, so nothing changes here. Radar's own server has these checks from
  the start (see "The local server").
- **Let hosts size the board** (found in M2; needs an `@shipbench/board`
  release). The board assumes it owns the viewport:
  `min-h-screen` on its root, a `top-0` sticky header, and `100vh` in five
  height calculations. A host with its own chrome above the board (Radar's
  tab bar, or a Harbor page header) has to override each one. A small fix:
  read two variables with today's values as fallbacks, e.g.
  `var(--sb-viewport-h, 100vh)` in place of `100vh` and
  `var(--sb-top-offset, 0px)` for the sticky offsets. A host would then set
  two custom properties and delete its overrides. Until then, Radar
  overrides the rules itself (see M2).

## Open questions

v1 answers each of these with a simple, provisional behavior (see "v1 plan").
The questions stay open because real use, not reasoning, should settle them.

- Whether the config directory should ever be synced between machines, given
  that paths are machine-local. *v1: it lives in `%APPDATA%\radar` and is not
  synced.*
- Whether a project can be registered by path alone before its identity is
  known, and what the entry looks like in the interval. *v1: no. `add`
  requires an identity, from the remote or from `--id`.*
- What happens to a tab whose repository has moved or been deleted: how
  loudly, and whether the entry survives so it can be repaired rather than
  silently dropped. *v1: the entry survives, and its tab shows it as
  unavailable and why.*
- Whether two worktrees of the same repository are one project or two.
  *v1: one. A second entry with the same identity is rejected.*
