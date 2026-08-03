## Project todos (Herdr sidebar count)

Open todos live in `TODOS.md` (todo.txt markup) at the project root. The Herdr
sidebar shows the open count next to the branch. Manage them with the engine —
do not hand-edit task lines except adding `- [ ] ` lines.

When asked to show/track todos, list/add/complete them, or open the todo pane,
run: `~/.config/herdr/herdr-todo <cmd>`

`<cmd>`: `list` (default), `status`, `add <body>` (e.g. `add "(A) Fix login @server +p0"`),
`done <id|text>`, `open <text>` (reopen), `next`, `init` (create TODOS.md),
`open` (open a live right-hand Herdr pane listing todos). Report stdout and stop.

Format: `- [ ]` open, `- [x]` done, `(A)` priority (A=highest), `+section`/`+project`,
`@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date).

Requires the `herdr-todo` Herdr plugin set up once:
`~/.config/herdr/herdr-todo setup`