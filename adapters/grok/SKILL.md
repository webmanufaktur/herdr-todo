---
name: todo
description: >
  Manage open todos in a project's TODOS.md or TODO.md (todo.txt markup) — list,
  add, complete, reopen, and status. The Herdr sidebar shows the open count next
  to the branch. Use when asked to show/track todos, list open tasks, add a task,
  mark something done, see what's left, or run /todo.
metadata:
  short-description: "Track open todos (TODOS.md / TODO.md)"
---

# /todo -- Project todos

Manage open todos in `TODOS.md` or `TODO.md` (todo.txt markup; `TODOS.md` preferred
when both exist). Always use the engine — never hand-edit task lines (except when
the engine is unreachable; see fallback below).

## Usage

Prefer the `todo` command on PATH (installed by `herdr-todo setup` into
`~/.local/bin/todo`). Fallbacks, in order:

```
todo <cmd>
~/.config/herdr/herdr-todo <cmd>
node <plugin-root>/todo.mjs <cmd>
```

If no `<cmd>` is given, use `list`.

## Commands

| Command | What it does |
|---|---|
| `list` (default) | List open tasks, grouped by section |
| `status` | Open counts per section |
| `add <body>` | Add a task, e.g. `add "(A) Fix login @server +p0 due:2026-01-15"` |
| `done <id\|text>` | Mark a task done (moves to Done + stamps `t:`) |
| `open <text>` | Reopen a done task (clears checkbox + strips `t:`) |
| `next` | Show the top-priority open task |
| `init` | Create a `TODOS.md` in cwd |
| `open` (no args, via herdr-todo) | Open a live right-hand Herdr plugin pane listing todos |

## Format

- `- [ ]` open, `- [x]` done
- `(A)`..`(Z)` priority, `(A)` highest
- `+section`/`+project`, `@context`
- `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date — only on completed tasks)

## Hand-edit fallback (only when `todo` is unreachable)

If every launcher above fails (PATH missing, plugin not set up, no node), you
may edit the todo file by hand. Match the engine's exact markup so the next
`todo` run stays consistent:

| Action | What to write |
|---|---|
| **Add** | `- [ ] (A) Task text @ctx +section due:YYYY-MM-DD` under a non-Done `##` section |
| **Complete** | Change `- [ ]` → `- [x]`, move the line under `## Done`, append ` t:YYYY-MM-DD` (today) |
| **Reopen** | Change `- [x]` → `- [ ]`, move out of `## Done`, **remove** any ` t:YYYY-MM-DD` |

Do **not** leave an open checkbox with a `t:` stamp, and do not leave a done
checkbox without moving it under `## Done`. Prefer restoring the engine:
`herdr plugin action invoke herdr-todo.setup` (installs `todo` on PATH).

Requires the `herdr-todo` Herdr plugin set up once:
`~/.config/herdr/herdr-todo setup`
