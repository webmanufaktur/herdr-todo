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
`done <id|text>`, `open <text>` (reopen), `next`, `init`, `pane` (open the live
right-hand pane; `pane --file <path>` renders that file instead). Bare `open` via
`herdr-todo open` also opens the pane; `open --file <path>` renders that file. Then show the stdout.

Format: `- [ ]` open, `- [x]` done, `(A)` priority (A=highest), `+section`/`+project`,
`@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date, completed tasks only).
File layout: `## GROUPNAME` groups, each with `### FEATURENAME` feature buckets
(any name — e.g. `### BACKLOG` for uncategorized ideas); `## Done` at the bottom
holds completed tasks. The file header carries the usage instructions — follow
them. Always use the engine — never hand-edit task lines unless the engine is
unreachable.

### Hand-edit fallback (only when both launchers fail)

- Add: `- [ ] (A) Task text` under a non-Done `##` group (inside a `###` bucket)
- Complete: `- [x] … t:YYYY-MM-DD` under `## Done`
- Reopen: `- [ ] …` outside Done, strip any `t:` stamp
- Then restore: `herdr plugin action invoke herdr-todo.setup`
