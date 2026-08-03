---
name: todo
description: >
  Manage open todos in a project's TODOS.md (todo.txt markup) — list, add,
  complete, reopen, and status. The Herdr sidebar shows the open count next to
  the branch. Use when asked to show/track todos, list open tasks, add a task,
  mark something done, see what's left, or run /todo.
metadata:
  short-description: "Track open todos (TODOS.md)"
---

# /todo -- Project todos

Manage open todos in `TODOS.md` (todo.txt markup). Always use the engine — never
hand-edit task lines (except adding new `- [ ] ` lines is fine).

## Usage

Run the engine and show its stdout:

```
~/.config/herdr/herdr-todo <cmd>
```

If no `<cmd>` is given, use `list`.

## Commands

| Command | What it does |
|---|---|
| `list` (default) | List open tasks, grouped by section |
| `status` | Open counts per section |
| `add <body>` | Add a task, e.g. `add "(A) Fix login @server +p0 due:2026-01-15"` |
| `done <id\|text>` | Mark a task done (moves to Done + stamps `t:`) |
| `open <text>` | Reopen a done task |
| `next` | Show the top-priority open task |
| `init` | Create a `TODOS.md` in cwd |
| `open` | Open a right-hand Herdr pane listing todos |

## Format

- `- [ ]` open, `- [x]` done
- `(A)`..`(Z)` priority, `(A)` highest
- `+section`/`+project`, `@context`
- `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date)

Requires the `herdr-todo` Herdr plugin set up once:
`~/.config/herdr/herdr-todo setup`