# herdr-todo

Portable todo tracking for coding agents — a `TODOS.md` file (todo.txt markup)
shared across every agent, a Herdr sidebar count next to your branch, and a
dedicated **todo tab** per present todo file (stays open even with 0 open tasks).

The file is the interface, not the agent: **any** agent (pi, OpenCode, Cline,
Grok, Kilo, Droid, Claude Code, …) or a human with a text editor can work with
the same todo file. The engine and plugin are thin layers over it. Discovery
accepts `TODOS.md` and `TODO.md` — **both are important** and each gets its own
tab, so both exist side-by-side (not "prefer one"). `todo init` still creates
`TODOS.md`.

```
 master  ~5 +2  ↑        ← branch · changed · untracked · git_status
 3 todos                  ← open todos (from TODOS.md / TODO.md, vanishes when 0)
```

## What you get

| Capability | How |
|---|---|
| **Portable todo file** | `TODOS.md` (or `TODO.md`) at project root, todo.txt markup, git-committed |
| **One engine, all agents** | `todo` — zero-dependency node script (`todo.mjs`) |
| **Sidebar count** | `herdr-todo` plugin polls each workspace, reports `$todos_open` (sums across both files) |
| **Auto-open todo tabs** | when a workspace is **active** — an agent is running there (any Herdr-detected kind: pi, opencode, cline, grok, kilo, droid, …) or it simply has panes open (covers manual agent launches) — the poller opens a dedicated **todo tab** per present todo file with a **live** `todo list` (refreshes every few seconds). The tab stays open even when all todos are done |
| **Open a todo tab** | `todo open` (or `<leader>t` in OpenCode) → a dedicated **todo tab** per present todo file with a **live** `todo list` that refreshes every few seconds |
| **`/todo` in your agent** | per-agent adapters (pi, OpenCode, Cline, Grok, Kilo, Droid) |

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

## Startup sync (automatic)

On every Herdr start (and on live server handoff) the plugin's `[[startup]]`
hook runs a lightweight **sync** — the idempotent subset of setup, with no git
pull and no package-manager installs:

- re-ensures the sidebar `$todos_open` token in `config.toml`
- rewrites the `~/.config/herdr/herdr-todo` launcher and `~/.local/bin/todo`
- re-registers the keep-alive poller (launchd/systemd; reload is a no-op when
  already loaded)
- re-copies the shared + planning skill `.md` files into `~/.agents/`,
  `~/.grok/`, and `~/.pi/` (skipped when unchanged; each target is independent
  so a missing mirror never aborts the boot)
- polls once so the sidebar reflects current state immediately

It is safe to re-run and never fails a boot: each step is wrapped so one
failure (e.g. a dangling `~/.pi` symlink, or the Herdr server being briefly
unreachable during the poll) is reported and skipped, not fatal. For a full
refresh — pulling source and reinstalling adapter packages — run `update`.

You can also trigger it manually:

```bash
herdr plugin action invoke herdr-todo.sync   # from Herdr
node herdr-todo.mjs sync                     # directly
```

## The `todo` engine

After `setup`, the engine is on PATH as `todo` (`~/.local/bin/todo`). You can
also call it via the plugin launcher (`~/.config/herdr/herdr-todo <cmd>`), which
proxies engine commands and owns the plugin-only ones (`open` tab, `setup`, …).

```
todo list [flags]            List open tasks (styled in a TTY; flat when piped)
todo status                  Open counts per group
todo add "<text>" [(A)] [+sec] [@ctx] [due:YYYY-MM-DD]
todo done <id|text>          Mark done (moves to Done + stamps t:)
todo open <text>             Reopen a done task (strips t:)
todo next                    Top-priority open task
todo init                    Create a TODOS.md in cwd
todo count                   Number of open tasks (for scripts/sidebar)
todo pane [--file PATH]      Open the live todo tab(s) (delegates to the
                             herdr-todo plugin; --file renders that file)
```

List flags: `--all`, `--plain`, `--ascii`, `--color always|auto|never`,
`--density compact|normal|relaxed`.

### Display

`todo list` picks a render mode automatically:

| Mode | When | Look |
|---|---|---|
| **styled** | Interactive TTY (default) | Unicode checkboxes, priority colors, **bold group headers + one card per `###` feature bucket**, dim tags, due-date urgency |
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

The live tab (`todo open` / `todo-watch.mjs`) uses the same renderer in-process.
It renders into the **normal screen buffer** — not the alternate screen — so the
pane scrolls natively in the terminal's scrollback, and repaints only when the
list actually changes (fs.watch + a periodic no-op check), so a quiet tab does
not spam scrollback with copies.

Two-level files (`## GROUPNAME` → `### FEATURENAME` buckets) render the group name as a bold header line with **one card per feature bucket** beneath it; a group without `###` buckets keeps a single card titled with the group name (old behavior).

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

## Live todo tab

`herdr-todo open` (or the plugin action / OpenCode `<leader>t`) opens a
**dedicated tab** per present todo file running `todo-watch.mjs`, which
re-renders the todo list every few seconds. `TODO.md` and `TODOS.md` each get
their **own tab** when both exist. Each tab is display-only — it is not an
interactive shell, so `herdr agent start` correctly refuses it
(`agent_pane_busy`) instead of hijacking the live list.

Add/complete tasks in `TODOS.md` / `TODO.md` (anywhere — the engine, an agent,
or your editor) and the tab updates automatically.

Render any file, not just the project's todo file — e.g. a template or example:

```bash
herdr-todo open --file example.md           # tab renders example.md (live)
herdr-todo open --file /abs/path/example.md # absolute path also works
node todo-watch.mjs 4 --file example.md     # direct in any shell pane
```

(`todo-watch.mjs` also honors `$TODOS_FILE`; the footer shows which file is live.)

### Auto-open (default on)

By default the poller **auto-opens** a todo tab for any **active** workspace
(one per present todo file) — and the tab **stays open even when all of that
workspace's todos are done** (the todo file is important, not just when it's
non-empty). "Active" is read from Herdr's **own** registry, in two layers:

- an **agent is running** there (`herdr agent list` / per-workspace
  `agent_status`) — works for every agent kind Herdr recognizes: pi,
  opencode, cline, grok, kilo, droid, …; or
- the workspace simply **has panes open** — this also covers agents launched
  by hand in a shell that Herdr can't yet classify (manual launches of any
  agent), so their todo tabs open too, with no agent-specific wiring.

It never duplicates a tab that's already showing a given file, and tracks which
tabs it opened in `~/.config/herdr/herdr-todo-state.json`. Disable it with
`HERDR_TODO_AUTO_OPEN=0` in the keep-alive environment.

Lifecycle details:

- A workspace with todo files but **no panes at all** (not attached/visible)
  gets no tab.
- Once open, a tab stays — even when its todos hit 0 — and reopens
automatically if it is closed while the agent keeps running.
- If a todo file is **deleted** from the repo root, its tab is closed.

Bonus: `herdr integration install pi|opencode|grok|kilo|droid` (done by
`adapters install`) lets Herdr recognize those agents even when launched in a
plain shell. Cline has no detection hook — start it with
`herdr agent start --kind cline` to get it listed as an agent.

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
| `node herdr-todo.mjs sync` | idempotent restore — the `[[startup]]` hook: tokens, launcher, todo on PATH, keep-alive, skill files, one poll (no git pull / package installs; safe to re-run) |
| `node herdr-todo.mjs update` | pull latest sources, re-setup, restart poller, reinstall adapters, reload plugin |
| `node herdr-todo.mjs teardown` | stop poller + remove token (reversible) |
| `node herdr-todo.mjs poller-status` | show poller state + per-workspace open counts |
| `node herdr-todo.mjs once` | poll once and report tokens |
| `node herdr-todo.mjs open` | open a todo **tab** per present todo file (live) |
| `node herdr-todo.mjs pane` | alias for `open` — opens the live todo tab(s); `pane --file <path>` renders that file |
| `node herdr-todo.mjs adapters list\|install` | show/install per-agent `/todo` adapters |

## Layout

```
herdr-todo/
├── herdr-plugin.toml        # Herdr plugin manifest (setup/update/teardown/status/open/adapters)
├── todo.mjs                 # the engine (CLI + importable module)
├── todo-ui.mjs              # pure ANSI list renderer (zero I/O; used by list + watch)
├── todo                     # shell launcher → node todo.mjs
├── todo-watch.mjs           # live-updating todo tab (the `todo open` payload)
├── herdr-todo.mjs           # Herdr plugin engine (poller + setup/teardown + adapters)
├── example.md               # canonical two-level todo template (## group → ### features)
├── test.mjs                 # engine test suite
├── .plans/                  # implementation plans (visual-todo, skill-opencode, …)
└── adapters/
    ├── pi/                  # pi package → /todo
    ├── opencode/            # slash command + tui-pkg (ctrl+x t)
    ├── cline/               # .clinerules/todo.md (project-level)
    ├── skill/               # shared Agent Skills SKILL.md (Grok, Kilo, any Agent-Skills tool)
    └── planning/            # shared planning-todos skill: plans in .plans/, todos via engine, agents in new tabs
```

## License

MIT