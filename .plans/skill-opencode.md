# Plan — General pi skill for planning + todos (+ Herdr layout rule)

> Tracking: `TODOS.md` task (B) — *General pi skill for planning and todos — write
> plans to `.plans/`, add tasks + refs to `TODO.md`/`TODOS.md`; agents
> (opencode/grok/etc.) always open in a new tab (not a pane split); live todo list
> is a right-hand pane on the first tab `@pi +skill`* (only open P0 task).
>
> **Plan only. No code changes in this step.** The only file this plan authorizes
> creating/editing is itself (`.plans/skill-opencode.md`). Authoring the actual
> `SKILL.md`, the `.plans/` migration, and any `adapters` wiring are described
> here as **future phases**.
>
> **Status:** Phase 1 + 2 being executed (this file now lives in `.plans/` per
> §6.2; the skill ships from this repo as `adapters/planning/SKILL.md`).

---

## 1. Goal

Define and ship a single **general pi skill** that every pi session on this
machine loads (planning = `zai/glm-5.2` "opencode"; execution = `xai/grok-4.5`
"grok"; both are pi sessions on different models — see
`~/.pi/agent/skills/delegate-models/SKILL.md`). The skill codifies three things
that today live only in the operator's head + scattered READMEs:

1. **Plans live in `.plans/`** (a new convention — existing plans sit at repo
   root; see §6 for migration).
2. **Task + plan-ref management always goes through the `todo` engine** into
   `TODOS.md`/`TODO.md` — never hand-edited (except the documented fallback).
3. **Herdr layout rule:** when an agent needs its own surface, it opens a **new
   tab** — never a pane split. The **live todo list is the one sanctioned split**,
   a right-hand pane on the first tab.

The skill is the contract between the planning agent (this one) and the
execution agent it hands off to.

## 2. Plan-only note (scope of *this* step)

This file is the deliverable. It does **not** create `SKILL.md`, does **not**
touch `todo.mjs` / `herdr-todo.mjs` / `herdr-plugin.toml`, and does **not** move
the existing `PLAN-*.md` files. Phases below describe the implementation work for
a later execution step (likely handed to grok).

## 3. Grounding — current state (concrete refs)

### 3.1 Plans today
- Three plan files live under **`.plans/`** (migrated per §6.2):
  `.plans/visual-todo.md`, `.plans/ansi-ui-opencode.md`, `.plans/setup-p0.md`,
  plus this plan (`.plans/skill-opencode.md`).
- `.plans/` **now exists** — plans are git-committed artifacts (`.gitignore`
  ignores only `node_modules/`, `*.log`, `.DS_Store`).

### 3.2 The todo engine (`todo.mjs`)
- Discovery walks up from cwd, preferring `TODOS.md` then `TODO.md`
  (`todo.mjs:31` `FILE_NAMES`, `todo.mjs:39`).
- `parse(text)` (`todo.mjs:52`) captures task tags via the regex at
  `todo.mjs:68`: `\+[^\s]+ | @[^\s]+ | due:[\d-]+ | t:[\d-]+`. **A `plan:` token
  is NOT captured** — see §7.3 for the implications.
- `cmdAdd(body)` (`todo.mjs:212`) → `insertIntoSection` (`todo.mjs:138`) appends
  the new line to the **first non-`Done` section** (top of the list). This is
  the exact entry point the skill will tell agents to use for "add task + ref".
- `cmdOpen(ref)` (`todo.mjs:236`) reopens a done task and strips `t:`.
- Engine is on PATH as `todo` (`~/.local/bin/todo`) after `herdr-todo setup`
  (README "Quick start"; `package.json:7` `"bin": { "todo": "./todo" }`).

### 3.3 The live todo pane (the sanctioned right-hand split)
- Declared in `herdr-plugin.toml:41-45`: entrypoint `todos`, `placement =
  "split"`, `command = ["node", "todo-watch.mjs", "4"]`.
- Opened by `openTodoPane()` (`herdr-todo.mjs:573`) as
  `herdr plugin pane open --placement split --direction right --target-pane
  <first-tab-pane>` (`herdr-todo.mjs:589-594`). The split target is chosen by
  `firstTabSplitTarget()` (`herdr-todo.mjs:535`) — explicitly the **first tab**
  (`firstTabId`, `herdr-todo.mjs:549`), preferring a non-todo shell pane
  (`herdr-todo.mjs:565`).
- Marked a display surface via `markTodoPaneDisplay()` (`herdr-todo.mjs:618`),
  which sets `--display-agent todos` (`herdr-todo.mjs:623`). Net effect:
  `herdr agent start` on that pane returns `agent_pane_busy` — agents cannot
  hijack the live list. Auto-open is on by default (`HERDR_TODO_AUTO_OPEN`,
  README "Auto-open").
- **Accurate description for the skill:** "a right-hand **split** pane on the
  **first tab**, display-only, opened/closed automatically by the poller."

### 3.4 Herdr's *default* agent-start topology (what the skill must override)
Per the canonical `~/.agents/skills/herdr/SKILL.md` (read for grounding):
- `herdr agent start` **requires an existing available shell pane** and "never
  creates, splits, or moves layout" (herdr SKILL.md §"Understand layout").
- herdr's own default guidance is `herdr pane split --current --direction right`
  (a **sibling split in the current tab**) before `agent start`. **This is
  exactly the behavior the new skill forbids for agent surfaces.**
- The tab-first alternative already exists: `herdr tab create` returns
  `.result.tab` + `.result.root_pane` (herdr SKILL.md §"Use IDs"). So the skill
  prescribes: `tab create` → `agent start --pane <root_pane>`.

> ⚠️ The task brief mentions a `wN:p6` slot. **That literal is not in the code**
> (`grep` of `herdr-todo.mjs` / `herdr-plugin.toml` finds no pane index). It
> reads as the operator's personal slot reservation, not a general rule. The
> skill will describe the layout **semantically** (first tab = work + todo
> split; agents get their own tabs) and will **not** hardcode a pane number. See
> Risks §11.

### 3.5 Existing skill precedents on this machine
- `~/.pi/agent/skills/delegate-models/SKILL.md` — the working delegate-routing
  skill; structural template (folded `description: >`, `metadata:` block, terse
  instructions, `PI_MODEL`/`PI_PROVIDER` env note). **The new skill should match
  this shape.**
- `adapters/grok/SKILL.md` — a per-agent `/todo` **command** skill, frontmatter
  `name: todo` (`adapters/grok/SKILL.md:2`). **This is a name-collision hazard**
  for the new skill — see §5.1.
- pi skill loader (`docs/skills.md`): global dirs `~/.pi/agent/skills/` and
  `~/.agents/skills/`; name rules (lowercase, hyphens, ≤64); description ≤1024
  chars and specific; invocable as `/skill:<name>`; collisions warn and "keep
  the first skill found".

## 4. What "general pi skill" means here

A single `SKILL.md` directory under a **global** pi skill location
(`~/.pi/agent/skills/<name>/`) so **every** pi session loads it — planner
(glm-5.2) and executor (grok-4.5) alike. Because "opencode" and "grok" on this
box are pi sessions on different models (delegate-models skill §"Mapping"), one
global skill covers all of them; no per-agent adapter is needed for the
*workflow* (the existing per-agent `/todo` command adapters remain unchanged and
orthogonal).

The skill is **advisory instructions** (it tells agents how to plan, where to
write plans, how to add tasks, and how to open agent surfaces). It does not ship
executable code in v1.

## 5. Skill identity

### 5.1 Name (must avoid collision)
- Existing collision: `adapters/grok/SKILL.md:2` is `name: todo`. If the new
  skill were also `todo`, pi would warn and keep whichever loads first —
  ambiguous.
- **Proposed name: `planning-todos`** (lowercase, hyphen, ≤64, no
  leading/trailing/consecutive hyphens — valid per `docs/skills.md`).
  Alternatives if rejected: `herdr-planning`, `agent-workflow`. The name is an
  open decision (§12.1).
- Directory: `~/.pi/agent/skills/planning-todos/SKILL.md`. Optionally also
  symlinked from `~/.agents/skills/` for cross-harness discovery (pi loads both;
  see `docs/skills.md` §Locations).

### 5.2 Frontmatter (draft)
```yaml
---
name: planning-todos
description: >
  Planning + todo workflow for this machine's pi agents. Write implementation
  plans to .plans/, manage tasks via the `todo` engine into TODOS.md/TODO.md
  (never hand-edit), and open any new agent surface as a NEW HERDR TAB — never a
  pane split. The live todo list is the one sanctioned right-hand split on the
  first tab. Use when planning a task, adding/managing todos, or handing work to
  another agent (grok execution, glm planning).
metadata:
  short-description: "Plans in .plans/, todos via engine, agents in new tabs"
---
```
- `description` is the load trigger — must mention the verbs the planner/executor
  will actually say ("plan", "todo", "hand to grok", "open an agent").
  Stays under 1024 chars.
- No `allowed-tools` / `disable-model-invocation` in v1 (let the model auto-load
  it; also expose `/skill:planning-todos`).

### 5.3 Skill body — required sections
1. **When to load** — planning a TODO task; adding/completing/reopening tasks;
   handing off to another agent; opening a new agent surface.
2. **Planning workflow** (§6 + §7) — read code → write `.plans/<slug>.md` →
   `todo add` a tracking task that references the plan → hand off to executor in
   a **new tab**.
3. **Plan-file convention** (§6) — the repo's established shape (quote the
   `TODOS.md` line in a `>` block, "Plan only" note, phased steps, scope-in/out,
   risks). Reference `.plans/visual-todo.md` / `.plans/ansi-ui-opencode.md` as the
   canonical examples.
4. **Todo engine cheat-sheet** — commands (`add`/`done`/`open`/`next`/`list`/
   `status`/`count`/`init`), file format, and the **blessed hand-edit fallback**
   (only when `todo` is unreachable; matches README "Hand-edit fallback").
5. **Herdr layout rule** (§8) — the hard part; see below.
6. **Delegate routing** — one line pointing at the `delegate-models` skill
   (planning/review → `zai/glm-5.2`; execution → `xai/grok-4.5`).

## 6. `.plans/` convention + migration of root `PLAN-*.md`

### 6.1 The convention the skill prescribes
- New implementation plans are written to **`.plans/<slug>.md`** at the project
  root (e.g. `.plans/visual-todo.md`). `<slug>` = kebab-case topic, matching the
  task's subject.
- `.plans/` is **git-committed** (plans are shared artifacts, like `TODOS.md`).
  No `.gitignore` entry.
- Filename: drop the `PLAN-` prefix inside `.plans/` (the directory is the
  namespace). So `PLAN-visual-todo.md` → `.plans/visual-todo.md`.

### 6.2 Migration of the three existing root plans (Phase 1)
- `git mv PLAN-visual-todo.md .plans/visual-todo.md`
- `git mv PLAN-ansi-ui-opencode.md .plans/ansi-ui-opencode.md`
- `git mv PLAN-opencode.md .plans/setup-p0.md` (it covers the original P0 setup
  fixes; rename for clarity — open decision §12.2)
- **This file** (`.plans/skill-opencode.md`) is itself the first plan written
  under the new convention; it was moved here by the §6.2 migration.
- Cross-references inside plans were updated to the new paths during the
  migration (e.g. `.plans/ansi-ui-opencode.md` cites `.plans/visual-todo.md` §3.2).

### 6.3 Discovery (optional, Phase 2)
- The `todo` engine does **not** need to know about `.plans/` — plans are not
  tasks. No `todo.mjs` change required for v1.
- Optional later: a `todo plans` subcommand that lists `.plans/*.md` (cheap:
  `readdirSync`). Out of scope for v1 (§9).

## 7. Task + plan-ref management via the engine

### 7.1 Always use `todo` — the skill's hard rule
The skill states: manage `TODOS.md`/`TODO.md` **only** through `todo add | done
| open | next | list`. Hand-editing is the documented last resort (engine
unreachable), with the exact markup table from the README so the next engine run
stays consistent. This is already the repo's stance (README "Hand-edit
fallback"; `adapters/grok/SKILL.md`); the skill simply re-asserts it globally.

### 7.2 Linking a task to its plan (the "refs" part)
When the planner writes `.plans/<slug>.md`, it adds a tracking task that
**references the plan in the task body**. v1 convention (no engine change):

```
todo add "(B) General pi skill for planning+todos — see .plans/skill-opencode.md @pi +skill"
```

- The plan path lives in the **prose body** (after an em-dash), so it shows in
  `todo list` and `todo next` and survives the engine's `clean` stripping
  (`todo.mjs:75` `tagless` only strips `+x/@x/due:/t:` tokens, not free text).
- Section tag `+skill` (or whatever `+section` fits) and context `@pi` are used
  as today.
- This is what the **current** `(B)` task already does (`TODOS.md` P0 line).

### 7.3 First-class `plan:` tag (optional, Phase 3 — scope-adjacent)
Making `plan:.plans/foo.md` a machine-discoverable tag requires extending the
`parse` regex at `todo.mjs:68` and the `tagless` stripper at `todo.mjs:81` to
also match `plan:[^\s]+`. That is an **engine change**, not a skill change —
flagged as out of scope for the skill itself (§9), noted as a future
enhancement. v1 uses prose refs (§7.2).

## 8. The Herdr layout rule (the skill's load-bearing section)

This is the rule most likely to be violated by an auto-loaded executor, so the
skill states it loudly and gives exact commands.

### 8.1 The rule
- **Agents always open in a NEW TAB.** When you need another agent surface
  (handoff to grok, a reviewer, a parallel worker), create a tab — not a split.
- **Never split a pane to host an agent.** This explicitly overrides herdr's own
  default (`herdr pane split --current --direction right` then `agent start`),
  which the canonical herdr skill prescribes. **The planning-todos skill wins**
  for this machine.
- **The live todo list is the ONE sanctioned split** — a right-hand pane on the
  first tab, owned by the `herdr-todo` plugin (`herdr-todo.mjs:573`
  `openTodoPane`, `--direction right` at `:593`; marked `--display-agent todos`
  at `:623`). Never target it with `agent start` (it returns `agent_pane_busy`
  by design).

### 8.2 Exact commands the skill prescribes (verified against herdr SKILL.md)
```bash
# 1. Create a new tab; it returns .result.tab and .result.root_pane
herdr tab create --workspace "$HERDR_WORKSPACE_ID"

# 2. Start the agent in that tab's root pane
herdr agent start <unique-name> --kind <kind> --pane <root_pane> -- <args...>

# 3. Prompt it
herdr agent prompt <name> --wait -- "<task text>"
```
- Read `root_pane` from `.result.root_pane.pane_id` (herdr SKILL.md §"Use IDs").
- Keep the agent's cwd correct (`--cwd` on `tab create` if supported, else
  `cd` inside the prompt).
- **Do not** use `herdr pane split` to obtain the agent pane.

### 8.3 First-tab hygiene
- The first tab is reserved for: the operator's interactive shell panes + the
  right-hand todo split (auto-opened). Do not pile agent tabs onto tab 1.
- The skill does **not** hardcode a pane index (the `wN:p6` literal is not in
  the code — §3.4). It describes the invariant: "todo split is rightmost on
  tab 1; everything else is its own tab."

## 9. Scope

### In scope (for the future implementation phases, not this step)
- Author `~/.pi/agent/skills/planning-todos/SKILL.md` (Phase 1).
- Migrate root `PLAN-*.md` → `.plans/` (Phase 1).
- Add an `adapters install` branch (or a small install note) so the skill is
  shipped from this repo and re-installed by `todo update` (Phase 2).
- Validate the skill loads (pi skill discovery; `/skill:planning-todos`).

### Out of scope (explicitly)
- **No engine change.** `todo.mjs` is untouched — no `plan:` tag, no `todo plans`
  subcommand in v1 (§7.3, §6.3).
- **No `herdr-todo.mjs` / `herdr-plugin.toml` change.** The todo pane mechanics
  already match the rule (§3.3). The skill is purely advisory instructions to
  agents.
- **No enforcement layer.** v1 relies on the skill being loaded and followed.
  A future extension could add a herdr hook that blocks `agent start` on a
  freshly-split pane (Phase 3+, cross-repo with Herdr core).
- **No changes to the existing per-agent `/todo` adapters** (pi/opencode/cline/
  grok). They are orthogonal command adapters; this skill is the workflow layer
  above them.
- **No non-pi agent support.** Real `opencode`/`grok` CLIs (if ever used outside
  pi) won't read a pi skill. On this machine they ARE pi models, so the single
  global skill suffices (§4).

## 10. Phased steps

### Phase 1 — Skill + `.plans/` convention (the deliverable)
1. Create `~/.pi/agent/skills/planning-todos/SKILL.md` with the frontmatter
   (§5.2) and the six body sections (§5.3). Keep it terse like
   `delegate-models`; the cheat-sheet can reuse the README tables.
2. Create `.plans/` at repo root; `git mv` the three root `PLAN-*.md` into it
   per §6.2; fix intra-plan cross-references.
3. Smoke-test: `pi` reload → skill appears in the startup header / is invocable
   as `/skill:planning-todos`; ask the planner model to "plan a small task" and
   confirm it writes to `.plans/` and adds a `todo add` task referencing it.
4. Add the layout rule + exact `herdr tab create` commands (§8) and confirm an
   executor (grok), when handed a task, opens a new tab rather than splitting.

**Exit criteria:** a fresh pi session loads the skill; planning writes to
`.plans/`; tasks reference plans via `todo add`; handoff opens a new tab; the
todo split on tab 1 is untouched.

### Phase 2 — Ship + install from the repo
1. Move the skill source into the repo (e.g. `adapters/planning/SKILL.md` or a
   top-level `skills/planning-todos/`) so it is version-controlled and travels
   with `todo update`.
2. Extend `cmdAdapters` (`herdr-todo.mjs:689`) with a branch that copies/links
   the skill into `~/.pi/agent/skills/planning-todos/` (mirror how the grok
   adapter is copied to `~/.grok/skills/todo/`).
3. Update `adapters list` output + README "Layout" to mention the skill.
4. Verify `herdr plugin action invoke herdr-todo.update` reinstalls the skill.

**Exit criteria:** `todo update` (or `adapters install`) lands the skill on any
machine that sets up the plugin; the global skill is reproducible from the repo.

### Phase 3 — Optional hardening (noted, not committed)
- `plan:` first-class tag in `todo.mjs:68` + a `todo plans` lister (§7.3, §6.3).
- A herdr-side guard that refuses `agent start` on a pane that is a same-tab
  split (enforces §8.1 mechanically). Cross-repo with Herdr core.
- Symlink the skill into `~/.agents/skills/` for non-pi harness discovery.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| **Name collision** with `adapters/grok/SKILL.md` (`name: todo`). pi keeps "first found" on collision (`docs/skills.md`). | Pick a distinct name (`planning-todos`, §5.1); verify with pi's skill list after install. |
| **The layout rule is advisory** — an auto-loaded executor may still `pane split` out of habit (herdr's own skill defaults to it). | State the rule in the **description** (load trigger) and at the **top of the body**; give exact `tab create` commands; Phase 3 adds a mechanical herdr guard. |
| **`wN:p6` literal not in code** — risk of encoding a wrong/hardcoded pane index. | Skill describes the layout **semantically** (todo split = rightmost on tab 1; agents = own tabs); no pane numbers. Confirm the operator's intent before Phase 1 (§12.3). |
| **`.plans/` migration breaks intra-plan links** (`PLAN-ansi-ui…` cites `PLAN-visual-todo…`). | `grep -rn "PLAN-" *.md` before `git mv`; update each reference; commit migration as one focused commit. |
| **Skill too verbose → not loaded / ignored.** pi loads by description match; a wall of text in the body is fine but the description must be sharp. | Keep `description` verb-rich and specific (§5.2); keep body scannable with tables + command blocks like `delegate-models`. |
| **Global skill drifts from repo reality** if authored only in `~/.`. | Phase 2 moves source into the repo and reinstalls via `adapters`/`todo update` (§10). |
| **`plan:` prose ref is invisible to tooling** (no machine-discoverable link). | Acceptable for v1 (refs show in `todo list`/`next`); Phase 3 adds the `plan:` tag if needed. |

## 12. Open decisions (defaults proposed; confirm before Phase 1)

1. **Skill name.** Propose `planning-todos`. Alternatives: `herdr-planning`,
   `agent-workflow`. Reject `todo` (collision) and `planning` (too generic).
2. **Rename `PLAN-opencode.md` on migration?** Propose `.plans/setup-p0.md`
   (its content is the original P0 setup fixes, not "opencode"). Alternatively
   keep `.plans/opencode.md` for continuity. Confirm with the operator.
3. **The `wN:p6` reference.** Confirm whether the operator wants a specific
   reserved pane slot encoded, or (recommended) the semantic rule only. Default
   in this plan: semantic only.
4. **Repo home for the skill source.** Propose `adapters/planning/SKILL.md`
   (consistent with sibling adapters) installed to `~/.pi/agent/skills/`.
   Alternative: a top-level `skills/planning-todos/`. Decide in Phase 2.
5. **Also symlink into `~/.agents/skills/`?** Cheap, aids cross-harness
   discovery. Propose yes in Phase 1 already.
