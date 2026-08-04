---
name: planning-todos
description: >
  Planning + todo workflow for this machine's pi agents (the prep layer before
  execution). Write implementation plans to .plans/, drive all
  TODOS.md/TODO.md changes through the `todo` engine (never hand-edit), and
  open ANY new agent surface as a NEW HERDR TAB — never a pane split; the live
  todo list is the one sanctioned right-hand split on the first tab. Use when
  planning a task, adding/completing/reopening todos, or handing work to
  another agent (grok executes, glm plans).
metadata:
  short-description: "Plans in .plans/, todos via the engine, agents in new tabs"
---

# Planning + Todos workflow

Applies to every pi session on this machine (planner `zai/glm-5.2`, executor
`xai/grok-4.5`; model routing lives in the `delegate-models` skill). Three rules:

1. **Plans → `.plans/`.** Implementation plans live at the repo root in
   `.plans/<slug>.md` (kebab-case slug, git-committed), shaped like
   `.plans/visual-todo.md`.
2. **Todos → `todo` engine, always.** Never hand-edit task lines in
   `TODOS.md`/`TODO.md` (fallback below only when the engine is unreachable).
3. **Agents → new tab, never a split.** The todo list is the one allowed
   right-hand split, on the first tab.

## When this loads

- Planning a task, or writing/updating an implementation plan
- Adding, completing, reopening, or listing todos
- Handing work to another agent (grok execution, glm planning/review)
- Needing a second agent surface in Herdr

## Planning workflow

1. Read the relevant code/docs first; root-cause before planning.
2. Write `.plans/<slug>.md` (shape below).
3. Add a tracking task that references the plan:
   `todo add "(B) <subject> — see .plans/<slug>.md @pi +<section>"`
4. Hand off to the executor in a NEW TAB (rule §5).

## Plan-file shape (`.plans/`)

Canonical examples: `.plans/visual-todo.md`, `.plans/ansi-ui-opencode.md`.

Sections: a `> ` tracking line quoting the TODOS.md task → goal → plan-only
scope note → grounded current state (concrete file/line refs) → phased steps →
scope in/out → risks & mitigations table → open decisions.

Filename = kebab-case topic, no `PLAN-` prefix (the directory is the namespace).
Plans are git-committed artifacts like `TODOS.md`.

## Todo engine cheat-sheet

| Command | What it does |
|---|---|
| `todo list [--all]` | List open tasks (styled in a TTY; flat when piped) |
| `todo status` | Open counts per group |
| `todo add "<text>" [(A)] [+sec] [@ctx] [due:YYYY-MM-DD]` | Add a task |
| `todo done <id\|text>` | Complete (moves to Done + stamps `t:`) |
| `todo open <text>` | Reopen a done task (strips `t:`) |
| `todo next` | Top-priority open task |
| `todo count` | Number of open tasks (scripts/sidebar) |
| `todo pane` | Open the live todo pane (delegates to the herdr-todo plugin) |

File format: `## GROUPNAME` groups → `### FEATURENAME` buckets (any name;
`### BACKLOG` is a common one for uncategorized ideas) → `- [ ]`/`- [x]` task
lines with `(A)`–`(Z)` priority, `+project`/`@context`,
`due:YYYY-MM-DD`, `t:YYYY-MM-DD` (done date, completed tasks only).

Example: `- [ ] (A) Add security headers @server +p0 due:2026-01-15`

### Hand-edit fallback (only when `todo` is unreachable — never otherwise)

| Action | Markup |
|---|---|
| Add | `- [ ] (A) Task text @ctx +section` under a non-Done `##` group (inside a `###` bucket) |
| Complete | `- [x] … t:YYYY-MM-DD`, move the line under `## Done` |
| Reopen | `- [ ] …` outside Done, **remove** any `t:` stamp |

Never leave an open checkbox with a `t:` stamp. Then restore the engine:
`herdr plugin action invoke herdr-todo.setup`

## Herdr layout rule (hard rule)

- **New agent surface = NEW TAB.** Create a tab, then start the agent in its
  root pane:
  ```sh
  herdr tab create --workspace "$HERDR_WORKSPACE_ID"   # → .result.tab + .result.root_pane.pane_id
  herdr agent start <name> --kind <kind> --pane <root_pane> -- <args...>
  herdr agent prompt <name> --wait -- "<task text>"
  ```
- **Never split a pane to host an agent.** This overrides herdr's own default
  (`herdr pane split --current --direction right` then `agent start`). The
  todo skill's tab rule wins on this machine.
- **The live todo list is the ONE sanctioned split** — right-hand pane on the
  FIRST tab, owned by the herdr-todo plugin, display-only. `agent start` on it
  returns `agent_pane_busy` — that is by design. Open it with `todo pane`.
- Keep the first tab for your interactive shell + the todo split; agents get
  their own tabs. Never hardcode a pane number (the layout is semantic).

## Delegate routing

Planning/review → `zai/glm-5.2`; execution → `xai/grok-4.5`. See the
`delegate-models` skill for the exact provider/model IDs and how to launch a
session on the right model.
