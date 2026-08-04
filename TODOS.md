# TODOS

> **Legend — what each prefix means**
> - `- [ ]` → open task &nbsp;·&nbsp; `- [x]` → done task
> - `(A)`–`(Z)` → priority, `(A)` = highest
> - `+section` / `+project` → group or project tag
> - `@context` → where/with-what (e.g. `@server`, `@client`)
> - `due:YYYY-MM-DD` → due date
> - `t:YYYY-MM-DD` → done date (stamped automatically when completed)
>
> Example: `- [ ] (A) Add security headers @server +p0 due:2026-01-15`
> Manage with `todo` (this project's engine) — never hand-edit task lines.

## P0 — Do first

- [ ] (A) Visual todo list appearance — explore options so the list looks more like a todo app, not a wall of text @ui +display
- [ ] (B) General pi skill for planning and todos — write plans to .plans/, add tasks + refs to TODO.md/TODOS.md; agents (opencode/grok/etc.) always open in a new tab (not a pane split); todo surface is a tab labeled todo @pi +skill
## P1 — Should do

## Backlog

## Done
- [x] move to master branch, we dont use main here t:2026-08-03
- [x] (A) No blessed hand-edit fallback when `todo` isn't reachable — conflicts with "never hand-edit task lines" @docs +p0 t:2026-08-04
- [x] (B) Open task stamped with `t:` (done-date) — engine counts it open but shows a done stamp (see Backlog evidence) @engine +p1 t:2026-08-04
- [x] (A) Auto-opened todo pane (wN:p6) is display-only — `herdr agent start` on it fails with agent_pane_busy @setup +p0 t:2026-08-04
- [x] Fix skill conflict: ~/.pi/agent/skills/delegate-models/SKILL.md has YAML error 'Nested mappings are not allowed in compact mappings' at line 2 col 14 +setup t:2026-08-04
- [x] (A) `todo` command is not on the shell PATH, so agents can't run the engine @setup +p0 t:2026-08-04