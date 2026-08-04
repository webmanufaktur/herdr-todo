# Plan — Visual todo list appearance

> Tracking: `TODOS.md` task (A) — *Visual todo list appearance — explore options so the
> list looks more like a todo app, not a wall of text `@ui +display`*.
>
> **Plan only. No code changes in this step.**

## 1. Current rendering path

Two surfaces render the todo list today, both ultimately funnelling through
`renderTask()` in `todo.mjs`:

| Surface | Entry | What it does |
|---|---|---|
| **CLI** `todo list [--all]` | `todo.mjs:179` `cmdList` → `renderTask` (`todo.mjs:199`) | Plain text. If `process.stdout.isTTY`, groups by `## Section` with a `## title` header and 2-space indent; if piped, flat list (machine-friendly). |
| **Live pane** (Herdr plugin pane `todos`) | `herdr-plugin.toml:44` runs `node todo-watch.mjs 4` → `todo-watch.mjs:22` `render()` spawns `node todo.mjs list` every 4 s | Clears screen (`\x1b[2J\x1b[H`), prints a **bold** title line (`\x1b[1m…\x1b[0m`) built from `todo count`, then the raw `todo list` output, then a static footer hint. No other styling. |

Other relevant facts discovered:

- **Zero-dependency project.** `package.json` declares no `dependencies`; the
  README and engine header lean hard on portability ("Zero dependencies").
  Any plan must respect this.
- **The plugin pane is display-only, not a shell.** `herdr-todo.mjs:530`
  (`openTodoPane`) opens it via `herdr plugin pane open` and marks it
  `--display-agent todos` so `herdr agent start` refuses it. → **Interactive
  TUIs (fzf/gum choose) cannot run inside the pane.** They can only be used by
  the CLI for one-shot selection.
- **Width is not read anywhere.** `todo-watch.mjs` and `cmdList` never consult
  `process.stdout.columns`. The right-hand split pane is typically narrow
  (~40–60 cols), so any layout must be width-aware and degrade gracefully.
- **Refresh model is full-screen clear + rewrite** on a 4 s timer. This is
  fine for ANSI styling; switching to the alternate screen buffer
  (`\x1b[?1049h`) would avoid scrollback flicker but is optional.
- **Color env:** `TERM=xterm-256color`; `NO_COLOR` convention is not honoured
  yet. Node 24, macOS/Linux only (per `herdr-plugin.toml`).
- Existing TUI surface `adapters/opencode/tui-pkg/index.js` only shells out to
  the launcher and shows toasts — it does not render the list itself, so it is
  orthogonal to this work (but will benefit automatically if `todo list`
  looks better).
- `test.mjs` asserts on list/count/done behaviour but not on formatting
  strings, so a styled TTY path + preserved `--plain`/pipe path keeps tests
  green.

## 2. Options surveyed

### 2.1 Hand-rolled ANSI styling (zero dep) — **recommended**

Use raw escape sequences (or a ~60-line helper) for color, bold, dim, and
unicode box-drawing for "card" sections. No npm install, no runtime binary
dep, full control over width/density.

- **Pros:** Zero deps; portable (works in any ANSI terminal + in the plugin
  pane); tiny footprint (~150–250 LOC); width-aware; honors `NO_COLOR`,
  `--color`, `FORCE_COLOR`; keeps a plain path for piping.
- **Cons:** We write (and minimally test) the styling primitives ourselves.
  Unicode box glyphs depend on terminal font support — mitigated by a
  `--plain`/ASCII fallback and density detection.

### 2.2 Tiny npm color lib (`picocolors` / `kleur` / `ansi-colors`)

~2–5 KB, single-file, no native deps. Would let us skip writing the 16-color
escape tables.

- **Pros:** Less hand-rolled escape code; well-tested.
- **Cons:** Breaks the project's zero-dependency stance; the value is small
  (the ANSI helpers we need are ~40 lines). **Not recommended** unless the
  project reverses its zero-dep policy.

### 2.3 Box/tables lib (`cli-table3`, `boxen`, `ink`)

- **Pros:** Rich layouts off the shelf.
- **Cons:** Multi-KB deps, some pull transitive deps (`ink` = React);
  `boxen`/`cli-table3` assume classic stdout widths and re-flow poorly in a
  narrow split pane. **Rejected** for this project.

### 2.4 External binary `gum` (charm.sh)

- **Pros:** Beautiful defaults; `gum format`, `gum table`, `gum style`.
- **Cons:** Not installed in this env; it's primarily *interactive*
  (`gum choose`/`confirm`) which the display-only pane can't use; adds a
  runtime + portability burden (`brew install gum`); licensing/distribution
  friction for a "portable" tool. **Not recommended as a hard dep.** Could be
  an *optional* enhancement (`gum format` if present) — see Phase 3.

### 2.5 External binary `glow` (markdown renderer)

Render `TODOS.md` directly with `glow` if installed.

- **Pros:** Zero engine work; pretty markdown.
- **Cons:** Renders the *raw* file (legend, headings, all sections) rather
  than the engine's filtered/grouped view; loses `todo list --all`/section
  filtering and the "done" date semantics; not installed; binary dep.
  **Rejected** as primary; could be an opt-in `--md` mode later.

### 2.6 `fzf` (present on this machine)

Interactive fuzzy picker. Useful for **CLI one-shot** flows
(`todo done` → pick from list), useless for the **live pane** (display-only).
Out of scope for *this* task (which is about appearance of the list, not
interaction), but worth noting as a future `todo done --pick` enhancement.

### 2.7 Full-screen TUI framework (`blessed`/`neo-blessed`/`ink`)

- **Pros:** App-like experience.
- **Cons:** Heavy deps; fights the Herdr plugin pane model (we don't own the
  tty lifecycle — the pane runs our command and re-renders on a timer);
  overkill for a list view. **Rejected.**

### 2.8 Recommendation

**Option 2.1 (hand-rolled ANSI, zero-dep)** as the primary path, with a
strictly optional, detection-based **Phase 3** enhancement that uses `gum`
or `glow` *only if present on PATH* (never required). This keeps the
project's zero-dependency promise, works inside the display-only Herdr pane,
and is width/density aware.

## 3. Proposed design

### 3.1 Visual language

- **Checkbox glyph:** `☐` open, `✓` done (or `✔`/`✗`). Fallback to `[ ]` /
  `[x]` under `--plain` or when `NO_COLOR`/ASCII mode is set.
- **Priority color** (16-color, color-blind-safe — never color-only):
  - `(A)` → bold red, `(B)` → yellow, `(C)` → blue, lower → default/dim.
  - Always keep the literal `(A)` letter so meaning survives mono/SSH/no-color.
- **Sections as cards:** top border `┌── P0 — Do first ──…──┐`, body rows,
  bottom border `└──…─┘` (box-drawing chars). Empty sections hidden (as today).
- **Header bar (pane only):** `12 open  ·  P0:3 P1:5 Backlog:4  ·  ↻ 4s` in
  bold/dim; replaces the single-line title in `todo-watch.mjs`.
- **Footer hint (pane only):** current one-liner, kept but dimmed; add a
  `edit TODOS.md` reminder and counts of done (when `--all`).
- **Metadata tags** (`@ctx`, `+proj`, `due:…`): dimmed grey so the task text
  dominates; `due:` within 0–2 days → bold yellow, overdue → bold red.
- **Density modes** (`--density compact|normal|relaxed`, default `normal`):
  - `compact`: one line per task, no inner padding.
  - `normal`: one line + 1 px of section padding (current feel, just styled).
  - `relaxed`: blank line between tasks; section cards with 1-line padding.
- **Width handling:** read `process.stdout.columns` (fallback 80); truncate
  task text with `…`; never wrap mid-tag.

### 3.2 Color control

- Honor, in precedence order: `--color always|auto|never`, then `NO_COLOR`
  (disables), then `FORCE_COLOR` (enables), then `process.stdout.isTTY`.
- Non-TTY (`todo list | …`, tests, the opencode tui-pkg toast consumer) →
  **plain text by default**, identical to today's pipe path. This is the
  machine-stable contract.

### 3.3 Refresh UX (pane only)

- Keep the 4 s timer + `SIGWINCH` redraw.
- Optionally switch to the **alternate screen buffer** on first draw and
  restore on exit (`\x1b[?1049h` / `\x1b[?1049l`) to avoid scrollback spam —
  gated behind a quick check; default on for the pane, off for `todo list`.
- Reduce spawn overhead: import the engine + renderer **in-process** instead
  of `spawnSync('node', ['todo.mjs', 'list'])` every tick. Watch the file
  with `fs.watch` for sub-second updates instead of a fixed 4 s poll
  (optional, Phase 2).

## 4. File touch list

### New

- **`todo-ui.mjs`** — pure rendering module. Exports:
  - `renderList(sections, opts)` → styled string (TTY).
  - `renderTask(t, opts)` → styled single line (moves the existing
    `todo.mjs:199` logic here, plain version kept as `renderTaskPlain`).
  - `renderHeader({open, perSection, interval})` and `renderFooter(opts)`.
  - Helpers: `c(text, color, style)`, `box(title, lines, width)`, `truncate`,
    `fitWidth`, `supportsColor(opts)`.
  - Density + color-flag resolution.
  - Zero exports of escape sequences; all go through `c()` so `NO_COLOR`
    works in one place.

### Edited

- **`todo.mjs`**
  - `cmdList` (`todo.mjs:179`): branch on TTY + color flag → call
    `renderList()` from `todo-ui.mjs`; otherwise today's plain path.
    Accept new flags `--plain`, `--color`, `--density`, `--ascii`.
  - `parseArgs` (`todo.mjs:337`): parse the new flags.
  - `renderTask` (`todo.mjs:199`): move to `todo-ui.mjs` and re-export for
    backward compat, or inline-call the plain variant.
  - `usage()` (`todo.mjs:349`): document new flags.
- **`todo-watch.mjs`**
  - Replace `render()` spawn (`todo-watch.mjs:22`) with an **in-process**
    import of `{ findTodos, parse }` from `todo.mjs` and `renderList`,
    `renderHeader`, `renderFooter` from `todo-ui.mjs`. Removes per-tick
    `spawnSync` cost.
  - `draw()` (`todo-watch.mjs:38`): use the new header/footer; honor
    `--all`; optionally enter alt-screen buffer.
  - Optional: `fs.watch(TODOS.md)` for instant refresh on save (Phase 2).
- **`herdr-plugin.toml`** — no change required (pane command stays
  `node todo-watch.mjs 4`). Optionally add a second pane variant or flags
  later (e.g. `node todo-watch.mjs 4 --density compact`).
- **`README.md`** — add a "Display" section: screenshots/ANSI snippet, the
  new flags, the `NO_COLOR`/`--color` contract, and the plain-by-default
  pipe behaviour.
- **`test.mjs`** — add cases: (a) `todo list` when piped is unchanged
    (regression guard), (b) `todo list --plain` equals today's TTY output,
    (c) `NO_COLOR=1 todo list` contains no ESC bytes, (d) `--color never`
    matches `NO_COLOR`. Do **not** assert on styled bytes (brittle); assert
    on plain-path stability and on flag semantics.

### Out of scope (noted for later)

- `adapters/opencode/tui-pkg/index.js` — leave as-is; benefits indirectly.
- `fzf`-based `todo done --pick` — separate interaction task.
- A "today / overdue / upcoming" date-grouped view — future enhancement.

## 5. Phased steps

### Phase 1 — MVP styling (zero dep, lands the biggest visual win)

1. Create `todo-ui.mjs` with `c()`, `supportsColor()`, `renderTask()` (plain
   + styled variants), and `renderList()` doing: checkbox glyph, priority
   color + dim tags, `## Section` headers (no box yet), empty-section skip.
2. Wire `cmdList` to use it on TTY (honor `--color`/`NO_COLOR`/`--plain`).
   Pipe path unchanged.
3. Switch `todo-watch.mjs` to import the engine + `renderList` in-process;
   add the new header bar (counts + per-section + `↻ Ns`) and dimmed footer.
4. Add the regression/flag tests above to `test.mjs`.
5. Update README "Display" section.

**Exit criteria:** `todo open` pane shows prioritised, glyph-led, colourised
tasks grouped under section headers with a real header bar; `todo list | cat`
is byte-identical to today.

### Phase 2 — Cards, density, width, live refresh

1. Add box-drawing `box()` helper; wrap each section as a card.
2. Implement `--density compact|normal|relaxed`.
3. Read `process.stdout.columns`; truncate with `…`; re-flow on `SIGWINCH`.
4. `due:` date highlighting (≤2 d yellow, overdue red).
5. Optional: `fs.watch` for sub-second refresh; optional alt-screen buffer.

**Exit criteria:** list looks like a card-based todo app in the pane;
narrow panes truncate cleanly; resize reflows immediately.

### Phase 3 — Optional external enhancement (only if binary present)

1. If `gum` on PATH and `--density` unset, optionally render section cards
   via `gum style --border` (graceful fallback to built-in renderer).
2. Optional `--md` mode that pipes the engine-filtered markdown through
   `glow` if present.
3. None of this is ever required; `--no-external` disables.

**Exit criteria:** users with `gum`/`glow` get a prettier render; everyone
else gets the Phase 1/2 renderer unchanged.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Box-drawing glyphs missing on some terminal/font | `--ascii` flag + auto-fallback when `TERM`/`NO_COLOR` suggests minimal support; tests assert the ASCII path. |
| Color-only meaning lost for color-blind users / SSH | Keep `(A)` literal and checkbox glyph; never encode meaning by colour alone. |
| Narrow pane truncates important info | Truncate the prose, never the `(A)` priority or `due:` tag; show `…` and keep full text on `--density relaxed` or via `todo next`. |
| Plain pipe consumers (tests, scripts, opencode toast) break | Plain path is the default for non-TTY; `--plain` forces it; add regression tests. |
| Spawn-per-tick overhead / flicker | Phase 1 already moves to in-process render; Phase 2 adds `fs.watch` + alt-screen. |
| Scope creep into interactive TUI | Explicitly out of scope; pane is display-only by design (`herdr-todo.mjs:530`). |

## 7. Open questions (to confirm before implementing)

1. Default density in the **pane** vs. the **CLI** — propose `normal` for
   both, `compact` when `stdout.columns < 60`.
2. Should the pane use the alternate screen buffer (cleaner, no scrollback)
   or keep clearing the visible buffer (current)? Propose alt-screen on,
   since it's a dedicated display pane.
3. Is a tiny single-file npm dep (`picocolors`) acceptable to avoid hand
  coding ESC sequences? Recommendation: **no**, stay zero-dep.
