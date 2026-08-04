# TODOS

> **How to use this file**
> - `## GROUPNAME` — a group of related work (e.g. `P0 — Do first`). Open groups at the top.
> - `### FEATURENAME` — a feature bucket inside a group; name it however you like
>   (e.g. `### BACKLOG` for ideas). Tasks live under a `###` heading.
> - Tasks are `- [ ]` (open) / `- [x]` (done) lines, with optional
>   `(A)`–`(Z)` priority, `+project`/`@context` tags and `due:YYYY-MM-DD`.
>   Completing stamps `t:YYYY-MM-DD` (done date) automatically.
> - Manage with `todo` (list/add/done/open/status/next/init) — never hand-edit task lines.
>
> Example: `- [ ] (A) Add security headers @server +p0 due:2026-01-15`

## P0 — Do first

### Planning

- [ ] (A) Write the project plan @pi +planning
- [ ] (B) Break the plan into feature buckets @pi +planning

### Core

- [ ] (A) Implement auth middleware @server +p0 due:2026-08-15
- [ ] (B) Add rate limiting @server +p0

## P1 — Should do

### UI

- [ ] (B) Redesign the settings page @client +ui
- [ ] (C) Add dark mode toggle @client +ui

### QA

- [ ] (B) Cover the engine with unit tests @tests +qa
- [ ] (C) Test list rendering in a narrow pane @tests +qa

## P2 — Later

### Ideas

- [ ] (C) Interactive picker for `todo done` @ui +ideas
- [ ] (C) Due-date grouped "today / overdue" view @ui +ideas

### BACKLOG

- [ ] (C) Voice-input todos (why not) @ideas +backlog
- [ ] (C) Export todos as PDF @docs +backlog
