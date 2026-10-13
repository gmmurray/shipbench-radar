# Radar

Several [ShipBench](https://github.com/gmmurray/shipbench) boards in one browser
window, one tab per repository.

`shipbench board` opens one project's board on its own port. Radar is one local
server that hosts the boards for every repository you register, switched by
tab. Each repository keeps its own `.shipbench/` folder. Radar stores no tasks,
and every change it makes lands in that repository's files, exactly as
`shipbench board` would make it.

> **A personal tool.** Radar is built around one developer's workflow, and the
> source is public for reference. It isn't published to npm or supported, and it
> has only been used on Windows. Issues and pull requests may go unanswered.

## What it does

- **One tab per project.** The URL names the open project (`#/my-repo`), so a
  pinned browser tab reopens where you left it.
- **Register everything, show what's active.** Close a tab to hide its
  project; it stays registered and watched, and reopens from the Projects
  menu, which marks hidden projects that changed.
- **Live updates.** When an agent, the CLI, or an editor changes a project's
  tasks, its board updates in place. Other tabs get a dot, so you can see which
  projects changed while you were looking elsewhere.
- **A Projects page** for adding, reordering, repairing, and removing projects.
  It suggests unregistered ShipBench projects next to the ones you already
  have, and can point a project at its new location after a repository moves.
- **A desktop launcher.** A console window starts the server: press `o` to
  open Radar in a new browser tab, or `q` to quit.
- **Localhost only.** The server listens on `127.0.0.1` and refuses requests
  from other websites, so a page open in your browser can't change your boards.

## Getting started

You need Node 24 or later, pnpm, and Git. Each project you add must already be
a ShipBench project (`shipbench init`).

```sh
git clone https://github.com/gmmurray/shipbench-radar.git
cd shipbench-radar
pnpm install

pnpm radar add ../my-project   # register a project (repeat per repository)
pnpm start                     # build, then serve http://127.0.0.1:4747
```

You can also add projects from the Projects page once Radar is running.

On Windows, `pnpm shortcut` puts a **Radar** shortcut on the desktop that opens
the launcher.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm start` | Build and serve Radar on `http://127.0.0.1:4747` |
| `pnpm console` | The same, with single-key commands (`o` open, `q` quit) |
| `pnpm shortcut` | Create the desktop shortcut to the launcher |
| `pnpm radar add <path> [--key k] [--id id]` | Register a project |
| `pnpm radar move <key> <path>` | Point a project at its new location |
| `pnpm radar list` | List projects and whether each is available |
| `pnpm radar show <key>` / `hide <key>` | Give a project a tab, or hide it (it stays registered) |
| `pnpm radar remove <key>` | Unregister a project (the repository is untouched) |
| `pnpm dev` | Development: the server and a Vite dev server |
| `pnpm test` / `pnpm typecheck` / `pnpm check` | Tests, type checks, lint and format |

## Configuration

Radar keeps its list of projects in `registry.json`, in `%APPDATA%\radar` on
Windows or `~/.config/radar` elsewhere. Set `RADAR_HOME` to use another folder.
[`registry.example.json`](registry.example.json) shows the format. The file is
safe to edit by hand, and a running Radar picks up changes without a restart.

`RADAR_PORT` changes the port. It defaults to `4747`, and the port is fixed so
that pinned tabs keep working.

## How it's built

[DESIGN.md](DESIGN.md) records the decisions behind Radar and the reasons for
them: one process with one ShipBench adapter per repository, a single shared
event stream, how the board is mounted, the local server's request checks, and
the registry format. Radar uses the published
[`@shipbench/core`](https://www.npmjs.com/package/@shipbench/core) and
[`@shipbench/board`](https://www.npmjs.com/package/@shipbench/board) packages.

## License

[MIT](LICENSE)
