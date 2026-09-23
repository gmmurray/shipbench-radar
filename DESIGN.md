# Radar — design notes

Status: pre-implementation. Nothing is built. Written 2026-09-21 against
ShipBench `core` / `board` / `cli` at 0.4.0.

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

- One HTTP server. Routes shaped `/api/:projectId/...`.
- Per registered project, `new FsAdapter(absolutePathToRepo)`.
- The API layer delegates to `@shipbench/core` — `loadConfig`, `listTasks`,
  `listArchivedTasks`, `createTask`, `updateTask`, `reorderTask`, `addComment`,
  `editComment`, `deleteComment`, `archiveTask`, `unarchiveTask`, `deleteTask`.
  It is transcribable almost directly from
  `../shipbench/apps/cli/src/boardServer.ts` (see the request handler at
  roughly lines 236-400). Nothing is invented; it is delegation.
- Frontend mounts `createBoard(el, { api })` from `@shipbench/board` per
  project, with a `BoardAPI` whose fetches carry the project id.
- One chokidar watcher per project, following the pattern in
  `../shipbench/apps/cli/src/tui/watch.ts` — the tasks directory plus
  `config.json` and `layout.json`, filtered to `.md` and those two files,
  150 ms debounce. That module is not exported from the CLI package; it is
  about thirty lines to reproduce.
- Server-sent events per project, so the tab bar knows which project changed.

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
  their own. IBM Plex Sans and Intel One Mono are needed. React 19 is a peer
  dependency.

One constraint that rules out a cheaper design: the shipped standalone bundle
hardcodes root-absolute `/api/...` paths. The published board app therefore
cannot be multiplexed under path prefixes such as `/board/foo/`. It is one
origin per board, or the host owns the shell. Radar owns the shell.

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

The tab bar listens to every project's event stream and marks the ones that
changed while attention was elsewhere. With agents working in several repos,
that indicator is likely the most useful thing Radar does, and it is close to
free — the per-project SSE stream already reports which project changed.

Electron is not required. A local page in a pinned browser tab is the same
experience with none of the packaging.

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
3. **Nothing about the interface.** Tab design, layout, and personal tuning
   stay here. That is the point of building it privately.

## Open questions

- Where Radar's config directory goes on Windows, and whether it should ever
  be synced between machines given that paths are machine-local.
- Whether a project can be registered by path alone before its identity is
  known, and what the entry looks like in the interval.
- What happens to a tab whose repository has moved or been deleted: how
  loudly, and whether the entry survives so it can be repaired rather than
  silently dropped.
- Whether two worktrees of the same repository are one project or two.
- Whether Radar should refuse to write to a repository that already has a
  `shipbench board` server running against it, or simply accept the
  last-write-wins exposure.
