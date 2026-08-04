# herdr-todo

Portable todo tracking for coding agents — a `TODOS.md` file (todo.txt markup)
shared across every agent, a Herdr sidebar count next to your branch, and a
right-hand pane listing open todos on the first tab.

The file is the interface, not the agent: **any** agent (pi, Claude Code,
OpenCode, Cline, Grok, …) or a human with a text editor can work with the same
todo file. The engine and plugin are thin layers over it. Discovery accepts
`TODOS.md` or `TODO.md` (preferring `TODOS.md` when both exist); `todo init`
still creates `TODOS.md`.

```
 master  ~5 +2  ↑        ← branch · changed · untracked · git_status
 3 todos                  ← open todos (from TODOS.md / TODO.md, vanishes when 0)
```

## What you get

| Capability | How |
|---|---|
| **Portable todo file** | `TODOS.md` (or `TODO.md`) at project root, todo.txt markup, git-committed |
| **One engine, all agents** | `todo` — zero-dependency node script (`todo.mjs`) |
| **Sidebar count** | `herdr-todo` plugin polls each workspace, reports `$todos_open` |
| **Auto-open a todo pane** | when a workspace has open todos, the poller opens a right-hand pane on the first tab with a **live** `todo list` (refreshes every few seconds); it closes again when all todos are done |
| **Open a todo pane** | `todo open` (or `<leader>t` in OpenCode) → right-hand pane on the first tab with a **live** `todo list` that refreshes every few seconds |
| **`/todo` in your agent** | per-agent adapters (pi, OpenCode, Cline, Grok) |

## Quick start

```bash
# 1. Install the Herdr plugin (wires sidebar token + keep-alive poller + PATH `todo`)
herdr plugin install webmanufaktur/herdr-todo --yes   # or: herdr plugin link ./herdr-todo
herdr plugin action invoke herdr-todo.setup
# setup installs ~/.local/bin/todo (engine) — ensure ~/.local/bin is on PATH

# 2. Install the /todo adapters for the agents you use
~/.config/herdr/herdr-todo adapters install

# 3. Create a TODOS.md in a project
cd <project> && todo init
```

## Updating / `todo update`

To update the installed plugin to the latest source — pulls the git checkout,
rewires the sidebar token + launcher, restarts the poller, reinstalls the
per-agent adapters, and reloads the Herdr plugin manifest — in one step:

```bash
todo update                 # via the /todo adapter
herdr plugin action invoke herdr-todo.update   # from Herdr
node herdr-todo.mjs update  # directly
```

Before it can pull, ensure your plugin checkout has no uncommitted changes:
`git -C <plugin-root> pull` will refuse otherwise. Then commit or stash and
re-run `update`.

## The `todo` engine

After `setup`, the engine is on PATH as `todo` (`~/.local/bin/todo`). You can
also call it via the plugin launcher (`~/.config/herdr/herdr-todo <cmd>`), which
proxies engine commands and owns the plugin-only ones (`open` pane, `setup`, …).

```
todo list [flags]            List open tasks (styled in a TTY; flat when piped)
todo status                  Open counts per group
todo add "<text>" [(A)] [+sec] [@ctx] [due:YYYY-MM-DD]
todo done <id|text>          Mark done (moves to Done + stamps t:)
todo open <text>             Reopen a done task (strips t:)
todo next                    Top-priority open task
todo init                    Create a TODOS.md in cwd
todo count                   Number of open tasks (for scripts/sidebar)
```

List flags: `--all`, `--plain`, `--ascii`, `--color always|auto|never`,
`--density compact|normal|relaxed`.

### Display

`todo list` picks a render mode automatically:

| Mode | When | Look |
|---|---|---|
| **styled** | Interactive TTY (default) | Unicode checkboxes, priority colors, section cards, dim tags, due-date urgency |
| **flat** | Piped / non-TTY | One plain task per line — **byte-stable** for scripts, tests, and adapters |
| **grouped** | `--plain` | Old `## Section` headers + indented plain lines (no ANSI) |

Color control (first match wins):

1. `--color always` / `--color never`
2. `NO_COLOR` (any value → off)
3. `FORCE_COLOR` (any value → on)
4. else: on when stdout is a TTY

Other display flags:

- `--ascii` — `[ ]` / `[x]` and ASCII box borders instead of unicode
- `--density compact|normal|relaxed` — spacing; default `normal`, auto-`compact` when the terminal is under 60 columns (unless you pass `--density` explicitly)
- Priority `(A)` rows are bold; overdue `due:` tokens go red (or get a trailing `!` when color is off)

The live pane (`todo open` / `todo-watch.mjs`) uses the same renderer in-process, draws on the **alternate screen** (clean Ctrl-C restore), refreshes on a timer, and also watches `TODOS.md` for sub-second updates after save.

### Hand-edit fallback (only when `todo` is unreachable)

Prefer the engine always. If every launcher fails (PATH missing, plugin not set
up), you may edit `TODOS.md` by hand — match this markup exactly so the next
engine run stays consistent:

| Action | Markup |
|---|---|
| **Add** | `- [ ] (A) Task text @ctx +section due:YYYY-MM-DD` under a non-Done `##` group (inside a `###` bucket) |
| **Complete** | `- [x] … t:YYYY-MM-DD` (today), move under `## Done` |
| **Reopen** | `- [ ] …` outside Done, **remove** any `t:YYYY-MM-DD` |

Never leave an open checkbox with a `t:` stamp. Restore the engine with
`herdr plugin action invoke herdr-todo.setup`.

## Live todo pane

`herdr-todo open` (or the plugin action / OpenCode `<leader>t`) opens a
**plugin-owned** right-hand pane on the first tab running `todo-watch.mjs`, which
re-renders the todo list every few seconds. Plugin panes are display surfaces
managed by Herdr — they are not interactive shells, so `herdr agent start`
correctly refuses them (`agent_pane_busy`) instead of hijacking the live list.

Add/complete tasks in `TODOS.md` / `TODO.md` (anywhere — the engine, an agent,
or your editor) and the pane updates automatically.

Render any file, not just the project's todo file — e.g. a template or example:

```bash
herdr-todo open --file example.md           # pane renders example.md (live)
herdr-todo open --file /abs/path/example.md # absolute path also works
node todo-watch.mjs 4 --file example.md     # direct in any shell pane
```

(`todo-watch.mjs` also honors `$TODOS_FILE`; the footer shows which file is live.)

### Auto-open (default on)

By default the poller **auto-opens** a todo pane for any workspace that has open
todos — and closes it again when all of that workspace's todos are done. It never
duplicates a pane that's already showing the todos, and tracks which panes it
opened in `~/.config/herdr/herdr-todo-state.json`. Disable it with
`HERDR_TODO_AUTO_OPEN=0` in the keep-alive environment.

## Format

`TODOS.md` (or `TODO.md`) is a **two-level structure** — `## GROUPNAME` groups, each
with `### FEATURENAME` feature buckets (any name; `### BACKLOG` is a common one for
uncategorized ideas) — over GitHub task-list checkboxes + todo.txt metadata tags.
A full working demo (3 groups × 2 features × 2 tasks) lives in [`example.md`](example.md)
and is the canonical template:

```markdown
# TODOS

> **How to use this file** — every todo file carries usage instructions in its
> header (written by `todo init`; `todo add` also writes them for a fresh file).

## P0 — Do first            ← GROUPNAME (group of related work)

### FEATURENAME              ← feature bucket: name it as you like
- [ ] (A) Add security headers @server +p0 due:2026-01-15

### BACKLOG                  ← example feature name (uncategorized ideas)

## P1 — Should do

## Done                      ← closed group at the bottom (completed tasks)
- [x] (A) Security headers @server +p0 t:2026-01-10
```

- `## GROUPNAME` — group of related work; open groups at the top, `## Done` last
- `### FEATURENAME` — feature bucket inside a group; name it however you like (e.g. `### BACKLOG` for uncategorized ideas)
- `- [ ]` open / `- [x]` done
- `(A)`..`(Z)` priority, `(A)` highest
- `+section`/`+project`, `@context`
- `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date — completed tasks only; reopen strips it)

## Herdr plugin commands

| Command | What it does |
|---|---|
| `node herdr-todo.mjs setup` | wire sidebar token + install keep-alive poller + `~/.local/bin/todo` (backs up config) |
| `node herdr-todo.mjs update` | pull latest sources, re-setup, restart poller, reinstall adapters, reload plugin |
| `node herdr-todo.mjs teardown` | stop poller + remove token (reversible) |
| `node herdr-todo.mjs poller-status` | show poller state + per-workspace open counts |
| `node herdr-todo.mjs once` | poll once and report tokens |
| `node herdr-todo.mjs open` | open a right-hand **plugin** pane listing todos |
| `node herdr-todo.mjs adapters list\|install` | show/install per-agent `/todo` adapters |

## Layout

```
herdr-todo/
├── herdr-plugin.toml        # Herdr plugin manifest (setup/update/teardown/status/open/adapters)
├── todo.mjs                 # the engine (CLI + importable module)
├── todo-ui.mjs              # pure ANSI list renderer (zero I/O; used by list + watch)
├── todo                     # shell launcher → node todo.mjs
├── todo-watch.mjs           # live-updating todo pane (the `todo open` payload)
├── herdr-todo.mjs           # Herdr plugin engine (poller + setup/teardown + adapters)
├── test.mjs                 # engine test suite
└── adapters/
    ├── pi/                  # pi package → /todo
    ├── opencode/            # slash command + tui-pkg (ctrl+x t)
    ├── cline/               # .clinerules/todo.md
    └── grok/                # SKILL.md (Agent Skills standard)
```

## License

MIT