---
description: Manage open todos (TODOS.md) — list, add, done, open, status, next, init
---

Manage the project's open todos in `TODOS.md` (todo.txt markup) and report the result.

Run the tick command and show its stdout:

```
~/.config/herdr/herdr-todo $ARGUMENTS
```

If `$ARGUMENTS` is empty, use `list`. Valid subcommands: `list`, `status`, `add <body>`,
`done <id|text>`, `open <text>`, `next`, `init`, `open` (open a live right-hand pane listing
 todos), `setup`, `teardown`. Then show the stdout.

Format: `- [ ]` open, `- [x]` done, `(A)` priority (A=highest), `+section`/`+project`,
`@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date). Always use the engine — never
hand-edit task lines (except adding `- [ ]` lines is fine).