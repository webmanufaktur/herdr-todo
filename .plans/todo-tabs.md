# Plan — Todo list as tabs (not a split pane)

> Tracking: TODO engine task — *todo list lives in a **dedicated tab per todo file**;
> the tab stays open even when no open tasks remain; every present todo file
> (`TODO.md` and `TODOS.md`) gets its own tab `@pane tab`.
>
> **Plan only. No code changes in this step.**

## 1. Goal

Change how the live todo list is surfaced in Herdr:

1. **A dedicated tab**, not a right-hand split pane on the first tab.
2. The tab **stays open** even when the workspace has **0 open tasks** (no
   auto-close on `count === 0`).
3. **Every present todo file is important** — each of `TODO.md` and `TODOS.md`
   gets **its own tab** when both exist (no more "prefer TODOS.md").

This reverses the earlier "one sanctioned right-hand split pane on the first
tab" design (see `.plans/visual-todo.md`, the `planning-todos` skill, README).

## 2. Grounded current state

Opening today goes through a **plugin-owned split pane** on the first tab:

- `openTodoPane()` (`herdr-todo.mjs:644`) → `herdr plugin pane open
  --entrypoint todos --placement split --direction right` on the first tab.
- Lives in `herdr-plugin.toml` as a `[[panes]]` entrypoint (`id = "todos"`,
  `command = ["node","todo-watch.mjs","4"]`).
- `markTodoPaneDisplay()` (`:691`) tags it `--display-agent todos` so
  `herdr agent start` refuses it.
- Auto-open (`autoOpenTodoPane`, `:293`) opens it only when `active &&
  count > 0`, and **closes it when `count === 0`** (`:297-300`).
- `findTodos()` (`todo.mjs:46`) returns **one** file (prefers `TODOS.md`).
- State (`~/.config/herdr/herdr-todo-state.json`) maps `workspace_id → pane_id`
  (`readState`/`writeState`/`pruneState`, `:127-152`).

**Verified live on this machine (throwaway tab, then closed):**

- `herdr tab create --workspace <ws> --cwd <dir> --label probe --no-focus`
  → `result.tab.tab_id` (`w1C:t3`) and `result.root_pane.pane_id` (`w1C:p9B`).
- `herdr pane run <root_pane> "node <abs>todo-watch.mjs 4 --file <abs>example.md"`
  renders the live list immediately in that root pane (card layout visible).
- `herdr tab close <tab_id>` removes the tab.

So the tab mechanism is fully supported by Herdr already — no Herdr core change.

## 3. Design

### 3.1 Open a dedicated tab per file — `openTodoTab(wsId, dir, file)`

Replace `openTodoPane` (plugin split) with a tab launcher:

```js
function openTodoTab(wsId, dir, file) {
  const label = `todos · ${basename(file)}`;
  const args = [herdrBin(), "tab", "create",
    ...(wsId ? ["--workspace", wsId] : []),
    "--cwd", dir, "--label", label, "--no-focus"];
  const created = run(args, { timeout: 10000 });
  // parse result.tab.tab_id + result.root_pane.pane_id
  const watch = join(__dirname, "todo-watch.mjs");
  const paneRun = run([herdrBin(), "pane", "run", rootPaneId,
    `node ${watch} 4 --file ${file}`], { timeout: 5000 });
  if (paneRun.code !== 0) { run([herdrBin(), "tab", "close", tabId]); return null; }
  markTodoTabDisplay(rootPaneId);
  return rootPaneId;
}
```

Notes:
- The tab's **root pane id** is what we track/return (that pane runs the watcher).
- `todo-watch.mjs` already accepts `--file <abs path>` (README) and honors
  `$TODOS_FILE`; we pass the file explicitly so separate tabs render separate
  files (not the discover-preferred single file).
- `markTodoTabDisplay(rootPaneId)` reuses the current `markTodoPaneDisplay`
  (`:691`) verbatim (still `--display-agent todos`), so `agent start` keeps
  refusing the list.

### 3.2 Discover **every** todo file — `todoFilesFor(root)`

Add a plural discovery helper (engine `findTodos` stays as-is for CLI default):

```js
// Order: TODOS.md first, then TODO.md — but never drop a file just because
// the other exists. Both are important.
const TODO_FILE_NAMES = ["TODOS.md", "TODO.md"];
function todoFilesFor(root) {
  if (!root || !existsSync(root)) return [];
  return TODO_FILE_NAMES.map((n) => join(root, n)).filter(existsSync);
}
```

Replace `findTodos`-based calls in the Herdr plugin with this where we need
"all files" (auto-open, `open`, counting). It returns `[]` when none exist.

### 3.3 State becomes per-file — `state[wsId][basename(file)] = paneId`

Change the persisted shape (`.config/herdr/herdr-todo-state.json`):

```js
// before: state[wid] = paneId
// after:  state[wid] = { "TODOS.md": "w1C:p3", "TODO.md": "w1C:p5" }
```

- `readState`/`writeState` unchanged (dict of dicts).
- `pruneState` (`:142`) recurses: drop a file entry whose pane id is no longer
  in `paneIdsByWs[wid]`; drop the whole workspace entry when empty.
- Backward-compat: migrate a legacy numeric/string `pid` value into
  `{ "_": pid }` on read so an old state file doesn't crash the recursion.

### 3.4 Auto-open — never close on `count === 0`, one tab per file

Rewrite `autoOpenTodoPane` → `autoOpenTodoTabs(wid, root, active, state, paneIdsByWs)`:

```js
function autoOpenTodoTabs(wid, root, active, state, paneIdsByWs) {
  if (!active) return;                 // no panes/agent → don't open
  const wsFiles = todoFilesFor(root);
  if (!wsFiles.length) return;
  const per = state[wid] || (state[wid] = {});
  const live = paneIdsByWs[wid] || [];
  for (const file of wsFiles) {
    const key = basename(file);
    const existing = per[key];
    if (existing && live.includes(existing)) continue; // already showing
    const pid = openTodoTab(wid, root, file);
    if (pid) per[key] = pid;
  }
  // Cleanup: close a tab whose file has been deleted from the root.
  for (const key of Object.keys(per)) {
    if (!wsFiles.some((f) => basename(f) === key) && per[key] && live.includes(per[key])) {
      closeTodoTab(per[key]); delete per[key];
    }
  }
}
```

Key behaviour changes vs today:
- **Removed** the `count === 0 → close` branch (`:297-300`). The tab stays open.
- Opened for any **active** workspace that has a todo file, regardless of open
  count (todo file is important, not just when non-empty).
- Inactive workspace (no panes) still gets nothing — a tab with no attached
  surface is pointless.
- `closeTodoTab(paneId)` = `herdr tab close` on the pane's owning tab (find
  tab via `pane get` or keep tab_id alongside pane_id in state).

### 3.5 `open` / `pane` commands

- `cmdOpen([])` / `cmdPane([])` → open a tab for **every** present todo file in
  the focused workspace root (both files get tabs when both exist). If none:
  keep today's `no TODOS.md or TODO.md … todo init` message.
- `open --file <path>` / `pane --file <path>` → open **one** tab rendering that
  file (unchanged intent; now via `openTodoTab`).
- Return text updated: `opened todo tab <paneId> (TODOS.md, live)`.

### 3.6 Sidebar token + counting

- `countOpenIn(root)` currently counts via the single preferred file. Keep the
  token per-workspace but **sum open tasks across all present todo files**
  (so `TODO.md` + `TODOS.md` together feed `todos_open`). Add
  `countOpenInAll(root)` → `todoFilesFor(root).reduce((n,f)=>n+countOpenInFile(f),0)`
  (refactor `countOpenIn` to a per-file helper).

### 3.7 Remove the plugin-owned split pane path

- `openTodoPane`, `openTodoPaneFallback` (legacy shell split), `closeTodoPane`,
  `firstTabSplitTarget` → deleted/replaced by tab functions.
- `herdr-plugin.toml`: remove the `[[panes]] id = "todos"` block (no longer a
  plugin-managed split pane) and update `description` to say **tab**.
- Keep `PANE_ENTRYPOINT` removal; `markTodoPaneDisplay` stays (rename to
  `markTodoTabDisplay` for clarity).
- `setup`/`teardown`/poller wiring: unchanged (tabs opened by actions + poller,
  not by a manifest `[[panes]]` entrypooint).

## 4. File touch list

### `herdr-todo.mjs`
- Add `TODO_FILE_NAMES` + `todoFilesFor(root)`; refactor `countOpenIn`→per-file + `countOpenInAll`.
- Replace `openTodoPane` with `openTodoTab` (tab create + pane run + mark).
- Replace `autoOpenTodoPane` with `autoOpenTodoTabs` (no count-0 close; loop files).
- Update `pruneState` for the per-file nested shape (+ legacy migration).
- `cmdOpen`/`cmdPane`: open all present files' tabs; `--file` opens one.
- Replace `closeTodoPane` with `closeTodoTab`; drop `openTodoPaneFallback`, `firstTabSplitTarget`.
- Rename `markTodoPaneDisplay`→`markTodoTabDisplay`; update `cmdStatus` per-workspace output to report files/tabs.
- Update header comment + `usage()` text (pane→tab).

### `herdr-plugin.toml`
- Remove `[[panes]] id = "todos"` block; update `description` (split pane → dedicated tab per file).

### `README.md`
- What-you-get table + "Live todo pane" + "Auto-open" sections: pane → **tab**;
  document that the tab stays open at 0 todos and that `TODO.md` and `TODOS.md`
  each get their own tab; update `todo pane` command description.

### `todo.mjs`
- No engine change required (`findTodos` stays for CLI default). `countOpenIn`
  in the plugin is refactored locally. `todo pane` help text updated in README.
  (Optionally add a plural `findTodosAll` export if the plugin wants to reuse —
  otherwise keep the helper in `herdr-todo.mjs`.)

### `test.mjs`
- No change (engine-level tests unaffected — no pane/tab logic in scope).

### `adapters/` + `planning` skill
- `adapters/planning/SKILL.md` and the global `planning-todos` skill say the
  todo list is "the one sanctioned right-hand split pane on the first tab" —
  update wording to "a dedicated todo tab per file" (the tab rule already wins).
  This is a follow-up doc edit; list here so it isn't forgotten.

## 5. Scope in / out

**In:** tab-based todo surface, per-file tabs, stays-open-at-0, both-files
count, state shape + prune migration, plugin manifest + README + skill wording.

**Out:** interactive TUI in the tab (still display-only via `todo-watch`), tab
theme/styling changes (already covered by `todo-ui.mjs`), auto-*closing* a tab
on deliberately-idle workspaces.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Stress on tab count: every active workspace with a todo file now holds a long-lived tab (even at 0 todos) | This is the wanted behaviour; keep auto-open gated on `active` so empty workspaces stay clean; cleanup closes a tab only when its file is deleted. |
| Legacy state shape (pane_id scalar) breaks recursion | Migrate scalar → `{ "_": pid }` in `readState`/`pruneState`. |
| `pane run` race on a brand-new tab shell | Same as today's fallback approach; `tab create` returns a ready root pane (verified). If `pane run` fails, close the tab and return null (no orphan). |
| Closing a tab requires its tab_id from a pane_id | `herdr pane get <pane_id>` has `tab_id`; or store `{ pane_id, tab_id }` per file in state. Store both for robust close. |
| Two files → two tabs feels heavy | Requirement 4 states both get their own tab; label clearly (`todos · TODO.md`). |

## 7. Open decisions (confirm with user before implementing)

1. Per-file state value: store just the pane_id, or `{ tab_id, pane_id }`?
   Recommend `{ tab_id, pane_id }` so `closeTodoTab` is direct and does not
   need a `pane get` round-trip.
2. Auto-open gating: keep "only active workspaces" (current), or open for any
   workspace that has a todo file even if empty? Recommend keep **active-only**.
3. On file deletion: auto-close that file's tab (recommended) vs. leave it.
4. Sidebar `todos_open`: sum both files (recommended) vs. keep preferred-file count.
