# Radar — design notes

Status: v1 (M0–M3) done 2026-09-23; launcher and Projects page done
2026-09-24 (see "After v1"); on ShipBench 0.6.0 since 2026-09-29. Written
2026-09-21 against
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

It is a personal tool. The source is public, but Radar isn't packaged,
published to npm, or supported for anyone else, and it isn't built for a
general audience. That is deliberate, and it is why Radar can be shaped around
one developer's actual working habits instead of a hypothetical user's.

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

It is customized for one person, so keeping it out of ShipBench removes any
obligation to generalize a decision before there is evidence for it.

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
- Frontend renders the `Board` component from `@shipbench/board` once per
  opened project, keeping inactive boards mounted but hidden (see
  "Mounting"), each with a `BoardAPI` whose fetches carry the project id.
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

Verified against the ShipBench repository at 0.4.0, and still true at 0.6.0:

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

What 0.5.0 changed for Radar (upgraded 2026-09-27):

- **Task slugs are confined to the tasks directory.** Core 0.4.0 pasted the
  slug into the path, so a request like
  `DELETE /api/projects/x/tasks/..%2F..%2FREADME` deleted that repository's
  README. Radar's request checks meant only its own page or a local process
  could send one, and a local process could delete the file anyway, but the
  route passed URL slugs straight through. Core now rejects them with
  `Invalid task slug`, which Radar answers with 400. `app.test.ts` covers
  it, and the test fails on 0.4.0.
- **Unreadable task files are surfaced, not dropped.** `listTasks` returns
  an `unreadable` array, which Radar passes through untouched, and the board
  shows those files in an Unreadable column. Writes to one throw
  `UnreadableTaskError`, which Radar answers with 422, as the CLI does.
- The key-listener and board-sizing fixes were not in 0.5.0. The layout
  overrides were re-checked in a browser against 0.5.0 and needed no change.

What 0.6.0 changed for Radar (upgraded 2026-09-29):

- **Board keyboard shortcuts skip hidden boards**, so Radar now keeps boards
  mounted (see "Mounting").
- **Hosts size the board with two CSS variables.** `--sb-viewport-h` is the
  height the board treats as its viewport, and `--sb-sticky-top` is where its
  sticky header and detail panel stop. Radar sets both on `.radar-board`, in
  place of the five rule overrides it carried before. Those overrides
  targeted class names that 0.6.0 renamed, so they would have silently
  stopped matching.
- Verified in Chromium:
  - a short board fits with no page scroll; on a long board, the header
    stays pinned under the tab bar
  - the detail sidebar sits exactly under both bars
  - a task open on one board survives switching away, and pressing Escape,
    `j` and ArrowDown on another board
  - switching back makes no requests
  - a hidden board shows a CLI change made while it was hidden
  - scroll position is restored per project
  - the tab title follows the visible board
  - there's still one event stream

One constraint that rules out a cheaper design: the shipped standalone bundle
hardcodes root-absolute `/api/...` paths. The hardcoding lives only in
`packages/board/src/standalone.tsx`, which is the CLI's `BoardAPI`; the library
entry is path-agnostic. The published board *app* therefore cannot be
multiplexed under path prefixes such as `/board/foo/`. It is one origin per
board, or the host owns the shell. Radar owns the shell.

## Mounting: boards stay mounted, inactive ones hidden

**Decision (since board 0.6.0, 2026-09-29): a project's board mounts the
first time its tab is opened and stays mounted. Inactive boards are hidden
with the `hidden` attribute, not unmounted.** Switching back is instant, with
no refetch, and keeps the open task, search, archive view, and scroll
position. A board unmounts only when its project is removed or becomes
unavailable.

Radar is a React app itself, so it renders the package's exported `Board`
component rather than calling `createBoard`, which would create a second
React root. `Board` takes the same `api` / `themeControl` / `documentTitle`
props that `createBoard` forwards to it.

This depends on board 0.6.0. Before it, two components listened for `keydown`
on `window` (`BoardCanvas` for Escape, `DetailView` for `j`/`k`/arrows), so a
hidden board still took every keystroke: Escape on the visible board closed
the hidden boards' open tasks, and a hidden board with a task open took over
the arrow keys. Radar therefore unmounted inactive boards through 0.5.0. The
fix Radar asked for upstream was a visibility gate rather than moving the
listeners onto the board's root, because key events only reach an element
that holds focus, and the standalone board would have ignored Escape whenever
focus sat on `<body>`. Board 0.6.0 shipped that gate: shortcuts reach only a
board that isn't hidden by `hidden` or `display: none`.

Consequences:

- **Title.** Only the visible board gets `documentTitle`. Toggling it hands
  the browser tab's title to whichever board is shown, and the board's
  cleanup restores the previous title.
- **Scroll.** All boards share the page's scroll, so Radar remembers the
  scroll position per view and restores it on switching (`App.tsx`).
- **Hidden boards stay current.** Each keeps its `onTasksChanged`
  subscription on the shared stream, so a change made while it was hidden is
  already on screen when its tab is opened.
- **Theme.** `themeControl` stays off. The toggle writes `data-theme` on
  `<html>` and `sb-theme` in `localStorage`, both page-global. Radar owns the
  theme; the board's CSS reads `data-theme` from `<html>`, as it does under
  Harbor.
- **Unread markers.** Radar's own writes can only come from the visible
  board, so they never mark a tab changed. The unread indicator reflects
  outside writes (agents, the CLI, an editor) without needing to tell writers
  apart.
- **Cost.** Each opened board keeps its store, and refreshes on its own
  project's events and when the browser tab regains focus. With a handful of
  projects that's negligible.

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

### Watched folders can't be moved on Windows

Radar watches each project's `.shipbench/` with native file watchers, the
same way `shipbench board` does. On Windows, an open watcher stops the
repository's folder (or any folder above it) from being renamed or moved:
Explorer reports the folder as in use, and `rename` fails with `EPERM`.
Closing the watcher releases it. Polling watchers don't lock, but they cost
CPU for every project and add up to their interval of latency to live
updates.

For now, move a repository while Radar is stopped (`q` in the launcher),
then repair the entry from its tab or the Projects page. If moves turn out
to be common, the options are polling watchers, or releasing a project's
watcher from the Projects page before a move.

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

Being registered and having a tab are separate. Registration is the durable,
slightly effortful step, so it makes sense to register every project you
might touch. Which ones have a tab is a lightweight, frequently changed
choice, made by hiding and showing (see "Shown and hidden projects" under
"After v1").

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
- **Registry:** `<config dir>/registry.json`. It was edited by hand until M3;
  now it's managed with `pnpm radar`, and hand edits still work.
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
  preferences, kept beside the entries rather than inside them: `ui.order`
  (tab order) and `ui.hidden` (projects registered but without a tab), both
  lists of keys, both read leniently. A missing registry file is an empty registry, since the
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

- One watcher per project whose directory exists, reproducing the CLI's. A
  project whose directory is missing gets no watcher. Since M3, every
  registry change retries the missing ones.
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
- Layout: the board sizes itself to the viewport. Through 0.5.0, Radar
  corrected five of its rules from `radar.css` by `--radar-tabs-h`. Since
  0.6.0 it sets the board's own sizing variables instead:
  `--sb-viewport-h: calc(100vh - var(--radar-tabs-h))` and
  `--sb-sticky-top: var(--radar-tabs-h)`, both on `.radar-board`.
- Theme: no `data-theme` on `<html>`, so the board follows the OS setting.
  A toggle can come later.
- **Verified** in Chromium with nine projects registered. A real `shipbench
  task move` in one project marked its tab while another was viewed. A CLI
  write to the viewed project appeared in about 300 ms, with no poll
  involved. Seven tab switches in a row each loaded in about 110 ms over
  one event stream. A short board didn't scroll the page, and on a long one
  the tab bar and board header stayed pinned. Both themes were checked.

### M3 — Registration

Done 2026-09-23. As built:

- `pnpm radar add <path> [--key <key>] [--id <id>]`:
  - **Path.** Must be an initialized ShipBench project, checked with the
    same `inspectProjectInitialization` the server uses. A relative path
    resolves against the directory `pnpm` was run from (`INIT_CWD`), not
    the package directory.
  - **Identity.** Comes from the `origin` remote through core's
    `parseGithubRemoteUrl`, as `github.com/<owner>/<repo>` in lowercase, so
    HTTPS, SCP-style, and `ssh://` remotes of one repository match. `--id`
    overrides it, and is required when there's no GitHub `origin`; the
    error suggests `local/<dir>`.
  - **Key.** Defaults to the repository name, or else the directory name,
    lowercased with other characters collapsed to hyphens.
  - **Rejected, each with its own message:** a duplicate key (suggests
    `--key`), a duplicate identity (the v1 worktree rule), and a path
    already registered under another identity (compared case-insensitively
    on Windows).
- `pnpm radar list` shows each entry with `ok` or `missing` and the reason.
  `pnpm radar remove <key>` removes an entry and never touches the
  repository.
- **Writes** (`registryFile.ts`) edit the raw JSON, so `ui` and unknown
  fields survive. They are validated by the loader's parser before writing,
  and land by temp-file rename, retrying briefly on Windows `EPERM`/`EBUSY`.
- **The server** watches the registry's directory (the file may not exist
  yet, and writes land by rename), debounces, re-reads, and reconciles in
  place. Unchanged entries keep their adapter and watcher; removed or
  changed ones are closed. Then it sends `registry-changed` on the shared
  stream, and the page re-fetches its list.
- **An invalid registry** on a live reload doesn't stop Radar. The last good
  registry keeps being served, and `/api/projects` carries
  `registryProblem`, which the page shows as a banner under the tabs. An
  invalid registry at startup still refuses to start, as in M1.
- **Verified:** tests drive `runCli` against real Git repositories and
  remotes, and a live server through add, remove, a missing directory that
  appears later, and a broken-then-fixed file. In Chromium, `pnpm radar add`
  and `remove` changed the open page's tabs within the debounce, with no
  reload. Removing the open project showed a notice, and a broken registry
  showed the banner over the still-working last good tabs.

### After v1

A theme toggle. (Keeping boards mounted, once listed here, shipped with board
0.6.0; see "Mounting".)

**Shown and hidden projects** (done 2026-10-13). After two weeks of real use,
the registry held about ten projects while only one to four were active at
a time. Re-registering is the friction, so the fix separates the two:
hiding a project keeps it registered and drops only its tab.

- **Storage.** `ui.hidden`, a list of keys beside `ui.order`, read
  leniently by `hiddenKeys()`. `/api/projects` reports `hidden` on each
  project. New projects start shown. Removing a project drops its key from
  `ui.hidden` as well as `ui.order`.
- **Hiding** works like closing a browser tab: a × appears on each tab on
  hover or keyboard focus. Hiding the open tab moves to its neighbour. A
  "Hid … · Undo" message stays up for six seconds, and clears if the
  project comes back some other way.
- **Reopening.** The "+ Projects" end of the tab bar is now a menu listing
  hidden projects, with a count, plus "Manage projects…". Opening a hidden
  project **by name** restores its tab, whether from the menu, a bookmark,
  or a pinned `#/key` URL: asking for it by name means you want it. Undo
  works the same way.
- **Hidden projects stay watched.** A change in a hidden project puts a dot
  on its menu entry and on the menu button, so agent activity is still
  visible without a tab. A hidden project's board unmounts, unless it is
  the one being opened.
- **Projects page** has "Tabs" (shown, reorderable) and "Hidden" sections,
  with "Hide" and "Show in tabs" buttons. Reordering the shown projects
  keeps hidden keys in `ui.order`, after the shown ones.
- **CLI:** `pnpm radar show <key>` and `hide <key>`; `list` marks hidden
  entries.
- **Escape** pressed while the menu is open closes the menu and is stopped
  in the capture phase on `document`, before the visible board's `window`
  listener, so it doesn't also close that board's open task.
- **Rejected: hiding projects automatically after a stretch with no
  activity.** It's unpredictable, and the user knows what's active this
  week.
- **Verified** in Chromium, with 24 checks plus one for the undo message:
  - × on hover; hiding a background tab
  - hiding the open tab moves to its neighbour; undo
  - `ui.hidden` saved
  - menu count and change dots
  - reopening from the menu shows the change made while hidden
  - Escape closes the menu but not an open task
  - a link to a hidden project restores its tab
  - the Projects page's Hide and Show in tabs; reordering keeps hidden keys

**Projects page** (done 2026-09-24), at `#/_projects`: keys can't contain
`_`, so the address can't clash with a project. A "+ Projects" link sits at
the far end of the tab bar.

- **Rules shared with the CLI.** `src/server/registration.ts` holds the add
  and repair rules. Both `pnpm radar` and the registry API
  (`/api/registry/…`) plan changes through it, and a refusal carries the
  field to fix plus, when there is one, a working example. The CLI turns
  that into its flag hint; the page highlights the input and offers the
  example as a button.
- **Repair** (`PATCH /api/registry/projects/:key`, and `pnpm radar move
  <key> <path>`) points an entry at a moved checkout. For a GitHub identity,
  the new checkout's origin must match, so a repair can't swap in a
  different repository. It's offered from each row on the page, and
  directly on an unavailable project's notice.
- **Add** previews as you type (`dryRun`): it shows the key and identity
  that would be used, and either can be overridden. **Suggestions** list
  unregistered directories with a `.shipbench/config.json` next to
  registered repositories. "Use" fills the add form; nothing is registered
  without the Add click.
- **Tab order** is dragged, or moved with arrow buttons, and saved as
  `ui.order` beside the entries. `inTabOrder()` reads it leniently: keys it
  names come first, everything else follows in registry order. Removing an
  entry drops its key from `ui.order`.
- **Remove** asks for confirmation and never touches the repository.
- **Writes** re-read the registry file before planning, so a broken file
  blocks them with a 409 until it's fixed. After writing, the API asks the
  server to reload before it responds, so the page's next list is current.
  That reload is the same one the file watcher triggers, so the server
  still learns about changes only by re-reading the file.
- **Last viewed project.** A visit with no hash, such as the launcher's `o`,
  opens the project last viewed in that browser (`localStorage`), falling
  back to the first available project.
- **Verified** in Chromium on real Git checkouts:
  - reordering with the arrows and by dragging reached the tab bar and
    `ui.order`
  - repair refused another repository's checkout, accepted the right one,
    and cleared the tab's strike-through
  - adding from a suggestion showed the preview and worked, including the
    identity example for a checkout with no remote
  - a folder that isn't a ShipBench project was refused in the preview
  - remove asked for confirmation first
  - repair from an unavailable project's notice loaded the board
  - a bare URL opened the last viewed project
  - the page was checked in both themes

**Desktop launcher** (done 2026-09-24). Chosen over starting at login: a
window you open when you want Radar fits the workflow better than a
background service, and it avoids the dev-port clash a service would bring.

- `scripts\radar.cmd` rebuilds quietly and runs the server with `--console`.
  `pnpm shortcut` puts a desktop shortcut to it (re-run it after moving the
  checkout). Startup failures keep the window open so the reason stays
  readable.
- In `--console` mode, single keys act on the running server: `o` opens
  Radar in a new tab of the default browser, `q` (or Ctrl+C) quits, `h`
  lists the keys. It never opens a tab by itself, because the Radar tab is
  usually still open from last time. Raw mode delivers Ctrl+C as a key, so
  it shuts down cleanly and cmd.exe never asks "Terminate batch job?".
- Launching while Radar already runs isn't an error. The second window
  checks that the port's owner answers Radar's API, says Radar is already
  running, and still offers `o`. A port held by anything else is reported
  as such.

## Non-goals

- Packaging, npm publishing, support, or a general audience. The source
  being public doesn't change this.
- Storing tasks. Every board's tasks stay in its repository.
- Merging boards into one view, or reconciling differing column sets.
- Cross-project search, or any cross-project index. A separate question with
  its own argument, currently open in the ShipBench spike.
- Cross-repository task dependencies, and cross-project references in task
  frontmatter. Ruled out in the spike: a committed reference resolvable only
  through an unversioned local registry would break the invariant that a
  repository's `.shipbench/` is self-contained.
- Automatic project discovery. Registration is explicit. The Projects page
  *suggests* ShipBench projects next to registered ones, but nothing is
  registered without a click, and nothing outside registered repositories'
  parent directories is scanned.
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
   stay here. That is the point of building it separately.

## Pending upstream

Nothing is pending. Everything Radar filed upstream has shipped:

- **CLI board server `Host`/`Origin` checks:** `shipbench` 0.5.0. Radar never
  used the CLI server and has had these checks from the start (see "The
  local server").
- **Task slugs confined to the tasks directory:** `@shipbench/core` 0.5.0.
- **Board key handlers ignore hidden boards:** `@shipbench/board` 0.6.0.
  Radar now keeps boards mounted (see "Mounting").
- **Let hosts size the board:** `@shipbench/board` 0.6.0, as
  `--sb-viewport-h` and `--sb-sticky-top`. Radar sets them instead of
  overriding the board's rules.

New findings go here as they come up.

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
  unavailable and why. Since the Projects page, it can be repaired in place,
  and a GitHub identity must match the new checkout.*
- Whether two worktrees of the same repository are one project or two.
  *v1: one. A second entry with the same identity is rejected.*
