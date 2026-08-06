## Project todos (Herdr sidebar count)

Open todos live in `TODOS.md` or `TODO.md` (todo.txt markup) at the project root
(`TODOS.md` preferred when both exist). The Herdr
sidebar shows the open count next to the branch. Manage them with the engine —
do not hand-edit task lines except when the engine is unreachable (see fallback).

When asked to show/track todos, list/add/complete them, or open the todo pane,
run (first that works):

```
todo <cmd>
~/.config/herdr/herdr-todo <cmd>
```

`<cmd>`: `list` (default), `status`, `add <body>` (e.g. `add "(A) Fix login @server +p0"`),
`done <id|text>`, `open <text>` (reopen), `next`, `init` (create TODOS.md), `pane`
(open the live todo tab(s) — one per present todo file; `pane --file <path>`
renders that file).
Bare `open` via `herdr-todo open` also opens the todo tab(s). Report stdout and stop.

Format: `- [ ]` open, `- [x]` done, `(A)` priority (A=highest), `+section`/`+project`,
`@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date, completed tasks only).
File layout: `## GROUPNAME` groups, each with `### FEATURENAME` feature buckets
(any name — e.g. `### BACKLOG` for uncategorized ideas); `## Done` at the bottom
holds completed tasks. The file header carries the usage instructions — follow
them.

### Hand-edit fallback (only when `todo` is unreachable)

| Action | Markup |
|---|---|
| Add | `- [ ] (A) Task text @ctx +section` under a non-Done `##` group (inside a `###` bucket) |
| Complete | `- [x] … t:YYYY-MM-DD` under `## Done` |
| Reopen | `- [ ] …` outside Done, **no** `t:` stamp |

Then restore the engine: `herdr plugin action invoke herdr-todo.setup`.

Requires the `herdr-todo` Herdr plugin set up once:
`~/.config/herdr/herdr-todo setup`
