# TODOS

> **How to use this file**
> - `## GROUPNAME` — group of related work (e.g. `P0 — Do first`). Open groups at the top, `## Done` at the bottom.
> - `### FEATURENAME` — a feature bucket inside a group; name it however you like
>   (e.g. `### BACKLOG` for uncategorized ideas). Tasks live under a `###` heading.
> - Tasks are `- [ ]` (open) / `- [x]` (done) lines under a `###` bucket, with optional
>   `(A)`–`(Z)` priority, `+project`/`@context` tags and `due:YYYY-MM-DD`.
>   Completing stamps `t:YYYY-MM-DD` (done date) automatically.
> - Manage with `todo` (list/add/done/open/status/next/init) — never hand-edit task lines.
>
> Example: `- [ ] (A) Add security headers @server +p0 due:2026-01-15`

## P0 — Do first

### Planning skill

- [ ] (B) General pi skill for planning and todos — write plans to .plans/, add tasks + refs to TODO.md/TODOS.md; agents (opencode/grok/etc.) always open in a new tab (not a pane split); live todo list is a right-hand pane on the first tab @pi +skill

### BACKLOG

## P1 — Should do

### BACKLOG

## Done

### Completed
- [x] move to master branch, we dont use main here t:2026-08-03
- [x] (A) No blessed hand-edit fallback when `todo` isn't reachable — conflicts with "never hand-edit task lines" @docs +p0 t:2026-08-04
- [x] (B) Open task stamped with `t:` (done-date) — engine counts it open but shows a done stamp (see Backlog evidence) @engine +p1 t:2026-08-04
- [x] (A) Auto-opened todo pane (wN:p6) is display-only — `herdr agent start` on it fails with agent_pane_busy @setup +p0 t:2026-08-04
- [x] Fix skill conflict: ~/.pi/agent/skills/delegate-models/SKILL.md has YAML error 'Nested mappings are not allowed in compact mappings' at line 2 col 14 +setup t:2026-08-04
- [x] (A) `todo` command is not on the shell PATH, so agents can't run the engine @setup +p0 t:2026-08-04
- [x] (A) Visual todo list appearance — explore options so the list looks more like a todo app, not a wall of text @ui +display t:2026-08-04

- [x] (B) Todo list as dedicated tabs — each present todo file (TODO.md or TODOS.md) gets its own tab; tab stays open even with 0 open tasks; see .plans/todo-tabs.md @ws +tab t:2026-08-06