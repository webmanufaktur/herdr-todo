# herdr-todo — Implementation Plan

Investigated the repo + runtime (engine, launcher, Herdr pane/agent capabilities). Root causes confirmed. No files touched yet.

## TL;DR — order & why

| # | Todo | Where | Effort | Why this order |
|---|------|-------|--------|----------------|
| 1 | **(A/P0)** `todo` not on PATH | `herdr-todo.mjs` | S | Root enabler — agents can't run *anything* until this lands |
| 2 | **(A/P0)** blessed hand-edit fallback **+ folds (B/P1)** `t:`-on-open bug | `todo.mjs`, README | S/M | Same surface (engine + docs); do together |
| 3 | **(A/P0)** auto-pane is display-only / `agent_pane_busy` | `herdr-todo.mjs` + Herdr core | M/L | Most involved; needs a pane-role concept. Independent of 1–2 |
| 4 | **[setup]** skill YAML error | `~/.pi/agent/skills/delegate-models/SKILL.md` | XS | 1-line unblock; slot anytime |

---

## 1. (P0) Put `todo` on the shell PATH

**Root cause.** `cmdSetup()` only writes a launcher for the *plugin* (`~/.config/herdr/herdr-todo` → `herdr-todo.mjs`), never for the *engine* (`todo`). `package.json` declares `"bin": { "todo": "./todo" }` (L7-9) but was never `npm link`-ed; `which todo` ⇒ not found. The shipped `./todo` (L1-3) uses `dirname "$0"`, so a bare symlink would also break (resolves to the symlink dir, not the repo). Writable PATH dir available and first on PATH: `~/.local/bin`.

**Change (in `herdr-todo.mjs`).**
- Add `writeEngineLauncher()` mirroring `writeLauncher()` (L275-282): writes `~/.local/bin/todo` as a **standalone** sh wrapper `exec node "<abs repo>/todo.mjs" "$@"`, then `chmod +x`. Standalone (not a symlink) so it survives repo moves and isn't defeated by `dirname $0`.
- Call it from `cmdSetup()` (L377) and `cmdUpdate()` (via the existing `cmdSetup` call, L419).
- Add a `pickBinDir()` helper: prefer `~/.local/bin` (writable + first on PATH); fall back to `/opt/homebrew/bin`; else warn with the exact `mkdir`/`PATH-export` instructions (ties into task 2's fallback doc).
- Extend `cmdStatus()` (L471-488): report `todo on PATH: yes (~/…local/bin/todo) | MISSING` via a `which todo` / probe, so drift is visible.
- `cmdTeardown()` (L459): optionally remove the engine launcher (confirm with user; default leave it).

**Verify.** Fresh shell: `which todo` resolves; `cd /tmp && todo count` works against the walked-up `TODOS.md`; `herdr plugin action invoke herdr-todo.setup` then `todo status`.

---

## 2. (P0) Blessed hand-edit fallback  **+**  (P1) `t:` stamp on open task

These share the engine + docs; doing them together avoids two passes.

### 2a. Engine hygiene — `t:` belongs only on done tasks

**Evidence.** `TODOS.md:24` `- [ ] … t:2026-08-03` (open box, done-date). Origin: `cmdOpen` (`todo.mjs:234-247`) flips `[x]→[ ]` via `toOpen` (L114-116) but never strips a stale `t:`. `renderTask` (L188-192) then prints it.

**Change (`todo.mjs`).**
- `toOpen()` (L114): also strip ` t:<date>` when reopening.
- `renderTask()` (L188): suppress `t:` tags on open tasks (defensive display).
- New `cmdCheck()` ("doctor"): scan `TODOS.md`, strip `t:` from any open task, warn on `[ ]` with `t:` / `[x]` without `t:` / malformed checkboxes; `--fix` to write. Wire into CLI switch (L298) + export.
- `parse()` (L63): flag `malformed:open-with-t` so the doctor can report.

**Exact code touchpoints (`todo.mjs`).**

```js
// L114 — toOpen: flip box AND drop a stale done-date
function toOpen(raw) {
  return raw
    .replace(/^[-*]\s+\[[ xX]\]/, "- [ ]")
    .replace(/\s+t:\d{4}-\d{2}-\d{2}$/, "");   // strip done-date on reopen
}

// L188 — renderTask: never show t: on open tasks
function renderTask(t) {
  const prio = t.priority ? `(${t.priority}) ` : "";
  const tags = t.tags.filter((tag) => t.open ? !/^t:/.test(tag) : true).join(" ");
  return `${prio}${t.clean}${tags ? "  " + tags : ""}`;
}

// New command — doctor / blessed repair
function cmdCheck(args) {
  const fix = args.includes("--fix");
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md found.");
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const issues = [];
  const fixed = lines.map((l) => {
    const m = l.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) return l;
    const isOpen = m[1].toLowerCase() === " ";
    const hasT = /\s+t:\d{4}-\d{2}-\d{2}(?:\s|$)/.test(l);
    if (isOpen && hasT) {
      issues.push(`open task has t: -> ${l}`);
      return fix ? l.replace(/\s+t:\d{4}-\d{2}-\d{2}/, "") : l;
    }
    if (!isOpen && !hasT) issues.push(`done task missing t: -> ${l}`);
    return l;
  });
  if (fix && issues.length) writeFileSync(file, fixed.join("\n"), "utf8");
  if (!issues.length) return "ok — no issues.";
  return (fix ? "fixed:\n" : "issues (run with --fix to repair):\n") + issues.join("\n");
}

// CLI switch (L298 area): add
case "check": return console.log(cmdCheck(rest));
```

**Tests to add (`test.mjs`).**
- Reopen a done task → resulting line has no `t:`.
- Open task with `t:` → `cmdCheck(["--fix"])` removes `t:` and returns a diff line.
- Done task missing `t:` → `cmdCheck` flags it (no write without `--fix`).
- `renderTask` on an open task omits any `t:` tag.

### 2b. Documented fallback (so "never hand-edit" is honest)

**Change (`README.md`, and the template embedded in `todo.mjs:263-283`).**
- Replace the unconditional "never hand-edit task lines" (README L12; template L274) with: **preferred `todo`; if unreachable, here is the blessed hand-edit contract**:
  - keep `- [ ]` / `- [x]` checkbox (one space inside brackets);
  - `(A)`..`(Z)` priority, if any, immediately after the checkbox;
  - tags as whitespace-separated tokens: `+project` / `+section`, `@context`, `due:YYYY-MM-DD`, `t:YYYY-MM-DD`;
  - stamp `t:` **only** on `[x]` done tasks — never on `[ ]`;
  - when `todo` is back, run `todo check --fix` to normalize anything you hand-edited.
- Point the contract at the exact `todo check` repair step from 2a. This resolves the (A/P0) "no fallback" conflict and gives the repair tool.

**Verify.** `node test.mjs` green for the new cases; manual: `todo done <ref>` then `todo open <ref>` leaves no `t:`; a hand-edited open line with `t:` is repaired by `todo check --fix`.

---

## 3. (P0) Auto-opened pane is display-only / `agent_pane_busy`

**Root cause.** `openTodoPane()` (`herdr-todo.mjs:492-510`) does `herdr pane split … --no-focus` then `herdr pane run <id> node todo-watch.mjs 4` (L508). That monopolizes the pane with a foreground process, so it's not "at its interactive shell prompt" — which `herdr agent start` requires (confirmed via `agent start --help`: *"The pane must be at its interactive shell prompt"*). Result: `agent_pane_busy`. `pane list` exposes `agent`, `agent_status`, `terminal_title` but **no role/kind** field — there's currently no way to mark a pane as a non-agent "sidecar".

This splits into an **in-repo** mitigation and a required **Herdr-core** change.

**Change — in-repo (`herdr-todo.mjs`).**
- Differentiate the two callers of `openTodoPane`:
  - **Explicit `todo open`** (L512, user opted in): keep the live `todo-watch.mjs` viewer (current behavior is fine — it's a dedicated pane).
  - **Auto-open** (`autoOpenTodoPane`, L218): do **not** `pane run` a blocking loop. Instead paint once and leave the pane at a shell prompt so it stays free for `agent start`. Keep it refreshed by the poller pushing a re-render into the pane (non-blocking) on each tick, or accept a manual refresh.
- Tag the pane so it's identifiable: set its **terminal title** to `§ todos` (the watch script can set it; `pane list` already exposes `terminal_title`). This gives a stable marker until Herdr has a real role field.

**Change — Herdr-core dependency (coordinate, likely out of this repo).**
- Add a pane **role/marker** (e.g. `pane split --role display`, or `pane set --role display <id>`).
- `agent start`, when targeted at a `display`-role pane, returns a clear error ("pane is a sidecar; pick a shell pane") **or** auto-splits a fresh shell pane for the agent. Until this exists, document that `agent start` must target a shell pane, not the `§ todos` sidecar.

**Decision point (ask before implementing):** prefer **(a)** non-blocking auto-open pane that stays free for agents, or **(b)** keep the live viewer but ship the Herdr `--role display` + agent-start redirect? (a) is fully in-repo and unblocks today; (b) is cleaner long-term but depends on Herdr core.

**Verify.** After auto-open: `herdr pane list` shows the sidecar at a shell prompt; `herdr agent start … --pane <sidecar>` either succeeds (option a) or gives a clear role error (option b); todos still render.

---

## 4. (setup) Fix delegate-models SKILL.md YAML

**Root cause.** `~/.pi/agent/skills/delegate-models/SKILL.md` L2-4: `description:` value is an **unquoted** scalar containing `: ` (in *"Prescribed division of labor: glm-5.2"*). YAML parses the post-colon part as a nested key ⇒ *"Nested mappings are not allowed in compact mappings"* at L2.

**Change.** Wrap the entire `description` value in double quotes (no inner `"` to escape). One-line edit. File is outside this repo (user home), so apply directly, not via the plugin.

**Verify.** `pi` reloads skills without the YAML error; `pi --list-skills` (or equivalent) shows `delegate-models`.

---

## Cross-cutting / risks

- **Keep-alive PATH:** the launchd plist (L292-314) bakes `PATH` at setup time; `~/.local/bin` is present, so the engine launcher will be reachable by the poller too. Re-run `setup` after changing `pickBinDir` defaults.
- **Tests:** extend `test.mjs` for `toOpen` strip, `cmdCheck`, and (if feasible) a mock-`herdr` harness for `openTodoPane` role behavior.
- **Out of scope:** per-agent adapter changes, sidebar token logic (working), `update` git-pull flow.

## Status

Tasks **1, 2, 4** are unblocked and proceed in the listed order. Task **3** is blocked on the (a) vs (b) decision above.
