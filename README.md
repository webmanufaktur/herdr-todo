# herdr-todo

Portable todo tracking for coding agents — a `TODOS.md` file (todo.txt markup)
shared across every agent, a Herdr sidebar count next to your branch, and a
right-hand pane listing open todos.

The file is the interface, not the agent: **any** agent (pi, Claude Code,
OpenCode, Cline, Grok, …) or a human with a text editor can work with the same
`TODOS.md`. The engine and plugin are thin layers over it.

```
 master  ~5 +2  ↑        ← branch · changed · untracked · git_status
 3 todos                  ← open todos (from TODOS.md, vanishes when 0)
```

## What you get

| Capability | How |
|---|---|
| **Portable todo file** | `TODOS.md` at project root, todo.txt markup, git-committed |
| **One engine, all agents** | `todo` — zero-dependency node script (`todo.mjs`) |
| **Sidebar count** | `herdr-todo` plugin polls each workspace, reports `$todos_open` |
| **Open a todo pane** | `todo open` (or `<leader>t` in OpenCode) → right-hand pane with a **live** `todo list` that refreshes every few seconds |
| **`/todo` in your agent** | per-agent adapters (pi, OpenCode, Cline, Grok) |

## Quick start

```bash
# 1. Install the Herdr plugin (wires sidebar token + keep-alive poller)
herdr plugin install webmanufaktur/herdr-todo --yes   # or: herdr plugin link ./herdr-todo
herdr plugin action invoke herdr-todo.setup

# 2. Install the /todo adapters for the agents you use
~/.config/herdr/herdr-todo adapters install

# 3. Create a TODOS.md in a project
cd <project> && todo init
```

## The `todo` engine

```
todo list [--all]            List open tasks (grouped by section)
todo status                  Open counts per section
todo add "<text>" [(A)] [+sec] [@ctx] [due:YYYY-MM-DD]
todo done <id|text>          Mark done (moves to Done + stamps t:)
todo open <text>             Reopen a done task
todo next                    Top-priority open task
todo init                    Create a TODOS.md in cwd
todo count                   Number of open tasks (for scripts/sidebar)
```

## Live todo pane

`todo open` opens a persistent right-hand Herdr pane running `todo-watch.mjs`,
which re-renders the todo list every few seconds. Add/complete tasks in
`TODOS.md` (anywhere — the engine, an agent, or your editor) and the pane
updates automatically.

## Format

`TODOS.md` uses GitHub task-list checkboxes + todo.txt metadata tags:

```markdown
# TODOS

## P0 — Do first
- [ ] (A) Add security headers @server +p0 due:2026-01-15

## P1 — Should do
- [ ] (B) Split client/src/api.ts @client +p1

## Done
- [x] (A) Security headers @server +p0 t:2026-01-10
```

- `- [ ]` open / `- [x]` done
- `(A)`..`(Z)` priority, `(A)` highest
- `+section`/`+project`, `@context`
- `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date)

## Herdr plugin commands

| Command | What it does |
|---|---|
| `node herdr-todo.mjs setup` | wire sidebar token + install keep-alive poller (backs up config) |
| `node herdr-todo.mjs teardown` | stop poller + remove token (reversible) |
| `node herdr-todo.mjs status` | show poller state + per-workspace open counts |
| `node herdr-todo.mjs once` | poll once and report tokens |
| `node herdr-todo.mjs open` | open a right-hand pane listing todos |
| `node herdr-todo.mjs adapters list\|install` | show/install per-agent `/todo` adapters |

## Layout

```
herdr-todo/
├── herdr-plugin.toml        # Herdr plugin manifest (setup/teardown/status/open/adapters)
├── todo.mjs                 # the engine (CLI + importable module)
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