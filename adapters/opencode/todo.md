---
description: Manage open todos (TODOS.md / TODO.md) — list, add, done, open, status, next, init
---

Manage the project's open todos in `TODOS.md` or `TODO.md` (todo.txt markup;
`TODOS.md` preferred when both exist) and report the result.

Run the first available engine and show its stdout:

```
todo $ARGUMENTS
```

If `todo` is not on PATH, fall back to:

```
~/.config/herdr/herdr-todo $ARGUMENTS
```

If `$ARGUMENTS` is empty, use `list`. Valid subcommands: `list`, `status`, `add <body>`,
`done <id|text>`, `open <text>` (reopen), `next`, `init`. Bare `open` via
`herdr-todo open` opens a live right-hand plugin pane. Then show the stdout.

Format: `- [ ]` open, `- [x]` done, `(A)` priority (A=highest), `+section`/`+project`,
`@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date, completed tasks only).
Always use the engine — never hand-edit task lines unless the engine is unreachable.

### Hand-edit fallback (only when both launchers fail)

- Add: `- [ ] (A) Task text` under a non-Done `##` section
- Complete: `- [x] … t:YYYY-MM-DD` under `## Done`
- Reopen: `- [ ] …` outside Done, strip any `t:` stamp
- Then restore: `herdr plugin action invoke herdr-todo.setup`
