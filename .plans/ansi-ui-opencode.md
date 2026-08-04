# Plan — Hand-rolled ANSI UI for the `todo` list (Option 2.1)

> Implementation plan for option **2.1 Hand-rolled ANSI styling (zero dep)** from
> `.plans/visual-todo.md`. Covers **Phase 1 (MVP styling)** and **Phase 2 (cards,
> density, width, live refresh)**. Phase 3 (optional `gum`/`glow`) is **out of
> scope** and intentionally omitted.
>
> **Plan only. No application code is changed in this step.** The only file this
> plan authorizes creating/editing is itself (`.plans/ansi-ui-opencode.md`).

---

## 1. Goal

Make the live `todo` tab (and `todo list` in a terminal) look like a todo app
instead of a wall of text, while:

- Staying **zero-dependency** (no npm packages; raw ANSI + unicode only).
- Keeping the **pipe / non-TTY** output byte-stable (tests, scripts, the opencode
  tui-pkg toast consumer, and `todo count` all rely on it).
- Working inside the **display-only** plugin tab (`herdr-plugin.toml:41`,
  `placement = "tab"`, label `todo`) — no interactive TUI assumptions.
- Honoring `NO_COLOR` / `FORCE_COLOR` / `--color` / `--plain` / `--ascii`.

## 2. Current state (concrete line refs)

### `todo.mjs` (engine)
- `parse(text)` `todo.mjs:51` → `{ sections: [{ title, tasks: [...] }] }`. Each
  task: `{ raw, open, priority, tags, clean }` (no `index` field despite the
  comment at `todo.mjs:49`). `tags` = array of `+proj` / `@ctx` / `due:YYYY-MM-DD`
  / `t:YYYY-MM-DD`. `clean` = body with priority + all tags stripped
  (`tagless`, `todo.mjs:77`).
- `cmdList(args)` `todo.mjs:179`:
  - Filters tasks (`all ? true : t.open`), skips empty sections.
  - `bySection = process.stdout.isTTY` (`todo.mjs:184`) — **the only TTY branch**.
  - Non-TTY (pipe): flat, one `renderTask()` per line (`todo.mjs:190`).
  - TTY: `\n## ${title}\n` header + 2-space-indented `renderTask()` lines
    (`todo.mjs:193-194`).
  - Returns trimmed string or `"no open todos. 🎉"`.
- `renderTask(t)` `todo.mjs:199-207`: `${prio}${clean}${tags ? "  " + tags : ""}`,
  where `prio = (X) ` and `tags` filters out `t:` for open tasks
  (`todo.mjs:203-205`). **This is the byte-stable plain contract.**
- `parseArgs(args)` `todo.mjs:337-347`: handles `--all`, `--section`,
  `--project`, `--context` (the last three are parsed but **not actually used**
  by `cmdList` today — only `all` is consumed).
- `usage()` `todo.mjs:349-364`.
- Exports `todo.mjs:367`: `findTodos, parse, openTasks, countOpen, FILE_NAME,
  FILE_NAMES, DEFAULT_SECTION`. **`renderTask` and `cmdList` are NOT exported.**
- CLI entry `runCli()` `todo.mjs:314-328`; direct-run guard `todo.mjs:370-373`.

### `todo-watch.mjs` (live tab payload)
- `render()` `todo-watch.mjs:22-26`: `spawnSync("node", [ENGINE, ...LIST])` every
  tick. `LIST = ["list"]` or `["list","--all"]` (`todo-watch.mjs:20`).
- `title()` `todo-watch.mjs:32-36`: **second** `spawnSync` for `todo count` per
  tick → 2 spawns per draw.
- `draw()` `todo-watch.mjs:38-43`: `\x1b[2J\x1b[H` clear, bold (`\x1b[1m`) title,
  rendered list, static footer string.
- Timer: `setInterval(draw, interval*1000)` `todo-watch.mjs:46`; `SIGWINCH` →
  `draw` `todo-watch.mjs:49`; `SIGINT`/`SIGTERM` → exit `todo-watch.mjs:50-51`.
- Args: `interval` (first numeric arg, default 4), `--all` `todo-watch.mjs:16-18`.

### `herdr-plugin.toml`
- Pane `todos`, `title = "todo"`, `placement = "tab"`,
  `command = ["node", "todo-watch.mjs", "4"]` (`herdr-plugin.toml:41-45`).
- Tab label `todo` is enforced separately by `labelTodoTab` in `herdr-todo.mjs:630`.

### `herdr-todo.mjs` (plugin host)
- `openTodoTab` `herdr-todo.mjs:587`, `markTodoPaneDisplay` `herdr-todo.mjs:637`
  (`--display-agent todos` → `herdr agent start` refuses the pane).
- `cmdOpen` `herdr-todo.mjs:709` → opens the tab; `runEngine` `herdr-todo.mjs:366`
  forwards engine subcommands to `todo.mjs`.

### `test.mjs`
- `run(args, cwd)` `test.mjs:11-14` uses `spawnSync` with no `stdio` override →
  **`stdout.isTTY` is `undefined` in every test** → tests exercise the **non-TTY
  flat path**. They assert on substrings (`includes`), never on exact formatting.
- `module import` block `test.mjs:141-145` imports the engine and checks
  `typeof countOpen === "function"`.

### Constraints confirmed
- `package.json`: zero `dependencies` (`package.json:1-14`). **Do not add any.**
- Node 24, macOS/Linux only (`.plans/visual-todo.md:35`).
- `TERM=xterm-256color`; `NO_COLOR` not yet honored anywhere.

## 3. Architecture

```
                ┌──────────────────────────────────────────────────┐
                │                   todo-ui.mjs                     │
                │  (pure rendering, zero I/O, zero deps, importable)│
                │                                                  │
                │  resolveOptions(env, argv, isTTY) -> opts         │
                │  renderTaskPlain(t)           -> string           │
                │  renderTaskStyled(t, opts)    -> string           │
                │  renderList(sections, opts)   -> string           │
                │  renderHeader(meta, opts)     -> string           │
                │  renderFooter(meta, opts)     -> string           │
                │  helpers: c(), glyph(), truncate(), fitWidth(),   │
                │           box(), dueState(), stripAnsi()          │
                └────────────┬──────────────────────┬───────────────┘
                             │ import               │ import
              ┌──────────────▼─────────┐   ┌────────▼──────────────┐
              │       todo.mjs         │   │    todo-watch.mjs     │
              │  cmdList branches on   │   │  in-process engine    │
              │  opts.mode: flat plain │   │  + renderer; alt-     │
              │  / grouped plain /     │   │  screen tab; timer +  │
              │  styled                │   │  fs.watch             │
              └─────────────────────────┘   └───────────────────────┘
```

Principles:
- **`todo-ui.mjs` is pure:** takes data + opts, returns strings. Never reads
  `process.argv`, `process.env`, `process.stdout`, or the filesystem. All of
  those are resolved by the caller into an `opts` object via `resolveOptions`.
  This makes it trivially unit-testable without faking a TTY.
- **One plain path, byte-stable.** `renderTaskPlain` is the exact extraction of
  today's `renderTask` (`todo.mjs:199-207`). The non-TTY output of `cmdList`
  must remain identical to today.
- **All escape sequences go through `c()`.** `NO_COLOR`/`--color never` flips a
  single boolean that makes `c()` return its text unmodified — no scattered
  `\x1b[…]` strings to hunt down.
- **No new deps.** No `package.json` change.

## 4. `todo-ui.mjs` API

### 4.1 Options resolution

```js
// resolveOptions(env, argv, isTTY) -> opts
//   env   : process.env (or a test fake)
//   argv  : the parsed args object from parseArgs (or a test fake)
//   isTTY : boolean (process.stdout.isTTY in prod)
//
// opts = {
//   mode:    "flat" | "grouped" | "styled",   // render mode (see §6)
//   color:   boolean,                          // emit ANSI color/style?
//   ascii:   boolean,                          // ASCII glyph fallback?
//   density: "compact" | "normal" | "relaxed",
//   width:   number,                           // resolved later by caller
//   all:     boolean,                          // include done tasks
// }
```

Resolution rules (implemented in this order):
1. `all` ← `argv.all ?? false`.
2. `ascii` ← `argv.ascii ?? false`.
3. `density` ← `argv.density ?? "normal"`.
4. `color` ← `resolveColor(argv.color, env, isTTY)` (see §5.2).
5. `mode`:
   - If `argv.plain === true` → `"grouped"` (force the old TTY format, no ANSI).
   - Else if `!isTTY && color === false` → `"flat"` (machine path).
   - Else → `"styled"`.
   - **Invariant:** non-TTY with no explicit `--color always` → `"flat"`. This is
     the pipe-stability contract.
6. `width` is **not** set here (no `process` access); the caller fills it from
   `process.stdout.columns ?? 80` before calling renderers.

### 4.2 `renderTaskPlain(t) -> string`
Exact extraction of `todo.mjs:199-207`. Output is byte-identical to today's
`renderTask`. Used by both the `"flat"` and `"grouped"` modes so the plain
contract lives in one place.

```js
function renderTaskPlain(t) {
  const prio = t.priority ? `(${t.priority}) ` : "";
  const tags = t.tags
    .filter((tag) => !(t.open && /^t:\d{4}-\d{2}-\d{2}$/.test(tag)))
    .join(" ");
  return `${prio}${t.clean}${tags ? "  " + tags : ""}`;
}
```

### 4.3 `renderTaskStyled(t, opts) -> string`
Single styled line. Layout (glyphs detailed in §5.1):

```
<glyph> <prio> <clean>  <tags>
```

- `<glyph>`: `☐` (open) / `✓` (done). ASCII: `[ ]` / `[x]`.
- `<prio>`: the `(X)` token, colored per priority (§5.1). Omitted if no priority.
- `<clean>`: `t.clean`, normal weight. Truncated with `…` if it overflows
  (§5.5). For `(A)` priority, the **whole line** is bolded (Phase 2 refinement)
  so high-priority tasks pop without color-only meaning.
- `<tags>`: two spaces, then tags. `@ctx`/`+proj` dim; `due:` colored by urgency
  (§5.6); `t:` (done only) dim. Open-task `t:` filtered exactly as in plain path.
- Done tasks: rendered dim + strikethrough (`\x1b[9m`), glyph `✓` dim-green.

When `opts.color === false`, the same string is returned **without ANSI** but
**with the unicode glyphs** (so `--color never` still looks structured). Use
`opts.ascii` to force `[ ]`/`[x]`.

### 4.4 `renderList(sections, opts) -> string`
Top-level list renderer. Iterates sections, filters tasks (`opts.all ? true :
t.open`), skips empty sections. Branches on `opts.mode`:

- `"flat"`: every task as `renderTaskPlain(t)`, one per line, **no headers**.
  (Byte-identical to today's non-TTY `cmdList` output, modulo the trailing trim
  which `cmdList` already does.)
- `"grouped"`: blank line, `## ${title}`, then 2-space-indented
  `renderTaskPlain(t)` lines — byte-identical to today's TTY `cmdList` output.
- `"styled"`: per-density layout (§5.4). Phase 1: section title line
  (bold + underline) then styled task lines, blank line between sections.
  Phase 2: each section wrapped as a card via `box()` (§5.3).

Returns `""` when no tasks; the `"no open todos. 🎉"` message stays in `cmdList`
(it's a CLI concern, not a renderer concern).

### 4.5 `renderHeader(meta, opts) -> string` (pane use)
`meta = { open, perSection: [{title, open}], interval, all }`. Produces one
styled line:

```
12 open  ·  P0 — Do first:3  P1:5  Backlog:4  ·  ↻ 4s
```

- Count bold; separators `·` dim; section counts dim; `↻ Ns` dim.
- When `opts.color === false`, plain `12 open  ·  P0:3 P1:5 Backlog:4  ·  @4s`
  (the `↻` glyph becomes `@` under `--ascii`; under plain-no-color it can stay
  unicode or degrade — keep unicode unless `--ascii`).
- `renderHeader` is used **only by `todo-watch.mjs`**, never by `cmdList`.

### 4.6 `renderFooter(meta, opts) -> string` (pane use)
`meta = { all, doneCount }`. Dimmed one-liner:

```
edit TODOS.md — updates here automatically  (showing 3 done)
```

The `(showing N done)` suffix only when `meta.all`. Phase 1 keeps the spirit of
today's static footer (`todo-watch.mjs:42`); Phase 2 adds the done count.

### 4.7 Helpers (internal, not exported except for tests)
- `c(text, ...codes)` — wrap `text` in `\x1b[…m…\x1b[0m`. When `opts.color===
  false`, return `text` unchanged. Codes are numeric SGR params (e.g.
  `c("x", 1)` → bold, `c("x", 31)` → red, `c("x", 2, 34)` → dim blue). All
  styling funnels through here.
- `glyph(name, opts)` — returns the right glyph for the mode: `open`→`☐`/`[ ]`,
  `done`→`✓`/`[x]`, `sep`→`·`/`|`, `arrow`→`↻`/`@`, box chars (§5.3).
- `truncate(text, max, opts)` — ellipsis-truncate; never splits mid-tag (the
  caller passes already-segmented pieces, see §5.5).
- `fitWidth(opts, fallback=80)` — `opts.width || fallback`.
- `box(title, bodyLines, width, opts)` — Phase 2 card border (§5.3).
- `dueState(dueStr, today)` → `"overdue" | "soon" | "normal"` (§5.6).
- `stripAnsi(str)` — for tests/width math (ANSI is zero-width visually).
- `visibleLen(str)` — `stripAnsi(str).length`.

### 4.8 Exports
```js
export {
  resolveOptions, resolveColor,
  renderTaskPlain, renderTaskStyled, renderList,
  renderHeader, renderFooter,
  // test-visible helpers:
  c, glyph, truncate, visibleLen, stripAnsi, dueState,
};
```

## 5. Visual rules

### 5.1 Glyphs & color table

| Element | Styled | `--ascii` |
|---|---|---|
| Open checkbox | `☐` (U+2610) | `[ ]` |
| Done checkbox | `✓` (U+2713) | `[x]` |
| Card corners | `┌ ┐ └ ┘` | `+ + + +` |
| Card horizontals | `─` | `-` |
| Card verticals | `│` | `\|` |
| Header separator | `·` (U+00B7) | `*` |
| Refresh marker | `↻` (U+21BB) | `@` |

Priority → color (16-color, never meaning-by-color-alone — the literal `(A)`
always stays):

| Priority | SGR | Token |
|---|---|---|
| `(A)` | bold red | `1;31` |
| `(B)` | yellow | `33` |
| `(C)` | blue | `34` |
| `(D)`–`(Z)` | dim | `2` |
| none | default | — |

Done tasks: dim (`2`) + strikethrough (`9`); glyph `✓` in dim green (`2;32`).

### 5.2 Color precedence (`resolveColor(colorFlag, env, isTTY)`)
Implemented in this exact order (matches `.plans/visual-todo.md` §3.2):

1. `colorFlag === "always"` → `true`.
2. `colorFlag === "never"` → `false`.
3. `env.NO_COLOR !== undefined` (any value, per `no-color.org`) → `false`.
4. `env.FORCE_COLOR !== undefined` → `true`.
5. else → `!!isTTY`.

`--color auto` is the default and falls through to steps 3–5.

### 5.3 Section cards (Phase 2)
`box(title, bodyLines, width, opts)` wraps a section. Two layouts depending on
`width`:

Wide (`width >= 60`):
```
┌─ P0 — Do first ─────────────────────────────────┐
│ ☐ (A) Add security headers  @server +p0 due:…   │
│ ☐ (A) Fix login bug         @client             │
└──────────────────────────────────────────────────┘
```

Narrow (`width < 60`): drop side borders to reclaim horizontal space:
```
── P0 — Do first ──────────────────
☐ (A) Add security headers  +p0
☐ (A) Fix login bug         @client
───────────────────────────────────
```

Title in the top border is bold; the `(A)`-priority body rows are bold (Phase 2).

### 5.4 Density (`--density compact|normal|relaxed`, default `normal`)

| Mode | Between tasks | Between sections | Section padding |
|---|---|---|---|
| `compact` | nothing | 1 blank line | none |
| `normal` | nothing | 1 blank line (or card gap) | 0 (card borders only) |
| `relaxed` | 1 blank line | 1 blank line around cards | 1-line top/bottom |

Auto override: if `width < 60` and `--density` was not explicitly passed, force
`compact` (narrow panes must stay dense). Explicit `--density` wins.

Phase 1 ships `compact` + `normal` (cards not yet drawn, so "normal" = titled
sections with blank lines between them). Phase 2 adds `relaxed` + the card
chrome and the auto-override.

### 5.5 Width & truncation
- Source: `process.stdout.columns ?? 80`. `todo-watch.mjs` reads it each draw
  (and on `SIGWINCH`); `cmdList` reads it once.
- Reserve: glyph(2) + space(1) + priority(4) + tags-area. The **clean text** is
  the truncation target.
- Truncation rule: render the fixed prefix (`<glyph> <prio> `), then fit as
  much `clean` as possible, then `  <tags>` if room; if `clean` itself overflows
  the remaining width, cut it and append `…` (single char, counted as 1).
- **Never truncate the `(A)` priority token or a `due:` tag.** If they don't
  fit, drop `+proj`/`@ctx` tags first (least important), then truncate `clean`.
- ANSI sequences are zero visual width — all width math uses `visibleLen()`.
- `--density relaxed` disables truncation of `clean` (let it wrap-free overflow
  is still avoided; instead the row is allowed to exceed width rather than lose
  text — narrow-pane users get `compact`/`normal` by default anyway).

### 5.6 Due-date highlighting (Phase 2)
- Parse `due:YYYY-MM-DD` from `t.tags`. Compare to **local** date (not UTC —
  display is for humans; note this differs from `stampDone`'s UTC
  `toISOString().slice(0,10)` at `todo.mjs:123`, which is fine because done-date
  stamping is an engine-write concern, not display).
- `dueState(dueStr, today)`:
  - `overdue` (due < today) → bold red (`1;31`) on the `due:` token.
  - `soon` (today ≤ due ≤ today+2d) → bold yellow (`1;33`).
  - `normal` (due > today+2d) → dim (`2`).
- When `opts.color === false`, no color, but the literal `due:` value is always
  preserved. Optionally append `!` for overdue in plain mode (decision §15.4).

## 6. Flag contract & `cmdList` integration

### 6.1 New flags (parsed in `parseArgs`, `todo.mjs:337`)
| Flag | Values | Default | Meaning |
|---|---|---|---|
| `--plain` | flag | off | Force the old grouped plain-text format (no ANSI, no glyphs). Escape hatch for TTY users who want text. |
| `--ascii` | flag | off | Use ASCII glyph fallback (`[ ]`, `+`, `\|`). Independent of color. |
| `--color` | `always`\|`auto`\|`never` | `auto` | Color control (§5.2). |
| `--density` | `compact`\|`normal`\|`relaxed` | `normal` | Spacing (Phase 2; Phase 1 accepts but only honors `compact`/`normal`). |

Env: `NO_COLOR` (disable), `FORCE_COLOR` (enable) — see §5.2.

### 6.2 `cmdList` rewrite (logic only — no behavior change for pipes)
Pseudocode for the new `cmdList(args)` (`todo.mjs:179`):

```js
function cmdList(args) {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found …");
  const sections = parse(readFileSync(file, "utf8"));
  const opts = resolveOptions(process.env, args, !!process.stdout.isTTY);
  opts.width = process.stdout.columns || 80;
  const out = renderList(sections, opts);
  return out.trim() || "no open todos. 🎉";
}
```

- `renderList` with `opts.mode === "flat"` reproduces today's non-TTY output
  byte-for-byte (regression test §10.3 enforces this).
- `opts.mode === "grouped"` (`--plain`, or a future user who forces it)
  reproduces today's TTY output byte-for-byte.
- `opts.mode === "styled"` is the new default for interactive TTY use.
- The `section`/`project`/`context` flags remain parsed-but-unused (as today);
  wiring them is out of scope (note in §13).

### 6.3 `renderTask` relocation
- Move the body of `renderTask` (`todo.mjs:199-207`) into `todo-ui.mjs` as
  `renderTaskPlain`.
- `todo.mjs` keeps a **thin re-export** for backward compat:
  `import { renderTaskPlain as renderTask } from "./todo-ui.mjs";` — or, to
  avoid changing the import shape for any external consumer, define
  `function renderTask(t) { return renderTaskPlain(t); }` in `todo.mjs`. Either
  way the symbol stays available and behaves identically.
- Do **not** add `renderTask`/`cmdList` to the engine's export list
  (`todo.mjs:367`) unless needed — keep the export surface unchanged.

## 7. `todo-watch.mjs` rewrite (in-process, alt-screen)

### 7.1 Why
Today each `draw()` does **two** `spawnSync` calls (`render` + `title`,
`todo-watch.mjs:22` & `todo-watch.mjs:32`) — ~process-start cost × 2 every
`interval` seconds. Moving in-process cuts that to zero spawns per tick and lets
us render the styled header/footer/card UI directly.

### 7.2 New structure
```js
import { readFileSync } from "node:fs";
import { findTodos, parse, openTasks } from "./todo.mjs";
import {
  resolveOptions, renderList, renderHeader, renderFooter,
} from "./todo-ui.mjs";

// args: interval (numeric, default 4), --all, --density <m>, --color <m>,
//       --ascii, --plain, --no-alt-screen
const opts = resolveOptions(process.env, parseWatchArgs(), true);
let todosFile = findTodos(process.cwd());   // re-discovered on ENOENT / change
let altScreenOn = false;
```

### 7.3 `draw()` (new)
```
1. todosFile ||= findTodos(process.cwd());           // re-discover if lost
2. read + parse; on read error → render error banner, keep last good frame.
3. compute meta = { open, perSection, interval, all, doneCount }.
4. opts.width = process.stdout.columns || 80;         // re-read each draw
5. frame =
     renderHeader(meta, opts) + "\n\n" +
     renderList(sections, opts) +
     (footer ? "\n" + renderFooter(meta, opts) : "");
6. writeFrame(frame);                                 // §7.4
```

### 7.4 `writeFrame(frame)` — flicker-free
- First draw: emit `\x1b[?1049h` (enter alt screen) unless `--no-alt-screen`.
  Set `altScreenOn = true`.
- Each draw: `\x1b[H` (cursor home) + `\x1b[J` (clear from cursor to end) +
  `frame`. This replaces today's `\x1b[2J\x1b[H` (`todo-watch.mjs:29`) and
  avoids the full-screen clear flicker.
- On exit (`SIGINT`/`SIGTERM`): if `altScreenOn`, emit `\x1b[?1049l` (leave alt
  screen) before `process.exit(0)`. Also restore cursor visibility
  (`\x1b[?25h`) defensively.

### 7.5 Refresh model
- Keep the `interval` timer as the reliable fallback (Phase 1) — same as
  `todo-watch.mjs:46`.
- `SIGWINCH` → immediate `draw()` (already at `todo-watch.mjs:49`); now it also
  re-reads `columns`.
- **Phase 2:** add `fs.watch(todosFile, debounce(draw, 120))` for sub-second
  refresh on save. The timer stays as backup (file watch is not 100% reliable
  across editors/network FS). Debounce coalesces rapid save bursts.
- Re-discover `todosFile` when the watch fires on a missing path (file
  deleted/recreated).

### 7.6 Args (`parseWatchArgs`)
Accept, in addition to today's `interval` + `--all`:
`--density`, `--color`, `--ascii`, `--plain`, `--no-alt-screen`. These forward
straight into `resolveOptions` (`isTTY = true` for the pane). `--plain` in the
pane gives the old grouped-text tab (useful for minimal fonts).

### 7.7 `herdr-plugin.toml`
**No change required** — `command = ["node", "todo-watch.mjs", "4"]`
(`herdr-plugin.toml:45`) keeps working. A later, optional tweak could pass
`--density compact`, but that is not part of this plan.

## 8. File touch list

### New
- **`todo-ui.mjs`** — pure rendering module (§4). ~200–280 LOC. No imports other
  than `node:...` (none needed). Exports per §4.8.

### Edited (Phase 1)
- **`todo.mjs`**
  - `parseArgs` (`todo.mjs:337`): add `--plain`, `--ascii`, `--color`, `--density`.
  - `cmdList` (`todo.mjs:179`): delegate to `renderList` via `resolveOptions`
    (§6.2). Delete the inline TTY branch (`todo.mjs:184-195`) — it is subsumed.
  - `renderTask` (`todo.mjs:199`): become a thin re-export of
    `renderTaskPlain` from `todo-ui.mjs` (§6.3).
  - `usage()` (`todo.mjs:349`): document the new flags.
  - Add `import { renderList, renderTaskPlain, resolveOptions } from "./todo-ui.mjs";`
    near `todo.mjs:24`.
- **`todo-watch.mjs`**
  - Replace the `spawnSync`-based `render`/`title`/`draw` (`todo-watch.mjs:22-43`)
    with the in-process version (§7).
  - Add alt-screen handling + `writeFrame`.
  - Keep interval + `SIGWINCH`/`SIGINT`/`SIGTERM` handlers.
- **`test.mjs`**
  - Add the regression + flag-semantics block (§10). Do **not** change existing
    assertions.

### Edited (Phase 2)
- **`todo-ui.mjs`**: add `box()`, `relaxed` density, auto-density override,
  due-date coloring, `truncate` refinements.
- **`todo-watch.mjs`**: add `fs.watch` debounced refresh; due-date highlight
  flows through `renderList` automatically.
- **`todo.mjs`**: no further changes (flags already wired in Phase 1).
- **`README.md`**: add a **"Display"** section — describe the three modes, the
  flag/env contract, the alt-screen pane, and an ANSI snippet. (Phase 2 doc
  polish; optional in Phase 1.)

### Untouched (confirmed)
- `package.json` (zero deps).
- `herdr-plugin.toml` (pane command unchanged).
- `herdr-todo.mjs` (plugin host — benefits automatically; no render logic there).
- `adapters/**` (orthogonal; they shell out to the engine and inherit the
  pipe-stable output, so `/todo` adapters are unaffected).
- `todo` shell launcher.
- Any `PLAN-*.md` other than this file.

## 9. Step order

### Phase 1 — MVP styling (lands the visible win)
1. **Create `todo-ui.mjs`** skeleton + exports: `resolveOptions`, `resolveColor`,
   `renderTaskPlain` (exact extraction of `renderTask`), `c`, `glyph`,
   `visibleLen`, `stripAnsi`.
2. **`renderTaskStyled`**: glyph + priority color + dim tags (no due-date color
   yet, no truncation yet). Honor `opts.color` / `opts.ascii`.
3. **`renderList`** with all three modes (`flat` / `grouped` / `styled`). Phase-1
   `styled` = titled sections (`bold` + `underline`) + styled lines, blank line
   between sections. No cards yet.
4. **`renderHeader` + `renderFooter`** (basic forms; footer keeps today's
   message).
5. **Wire `todo.mjs`** `cmdList` → `resolveOptions` + `renderList` (§6.2); extend
   `parseArgs`; relocate `renderTask`; update `usage()`.
6. **Rewrite `todo-watch.mjs`** to import engine + `todo-ui.mjs` in-process
   (§7), with `renderHeader`/`renderList`/`renderFooter` and alt-screen.
7. **Add tests** (§10) and run `node test.mjs` until green.
8. **Manual smoke test**: `todo list` in a terminal (styled), `todo list | cat`
   (flat, unchanged), `todo open` (pane), `NO_COLOR=1 todo list`, `--plain`,
   `--ascii`, resize the tab.

**Phase 1 exit criteria:** the `todo` tab shows prioritised, glyph-led,
colourised tasks under section titles with a real header bar; `todo list | cat`
is byte-identical to today; `node test.mjs` passes including new cases.

### Phase 2 — Cards, density, width, live refresh
1. **`box()` helper** + card-wrapped sections in `renderList` `styled` mode
   (wide layout; narrow layout drops side borders — §5.3).
2. **`--density relaxed`** + the auto-override (`width < 60` → `compact`).
3. **Width truncation**: `truncate` + `fitWidth` + reserved-width logic (§5.5).
    Re-flow on `SIGWINCH` (already redraws; just re-read `columns`).
4. **Due-date coloring**: `dueState` + wire into `renderTaskStyled` tag rendering
    (§5.6). Bold-`(A)`-line refinement here too.
5. **`fs.watch` debounced refresh** in `todo-watch.mjs` (timer stays as backup).
6. **README "Display" section.**
7. **Extend tests**: ASCII fallback shape, `relaxed` spacing, due-date plain
   fallback, width truncation of `clean` only.

**Phase 2 exit criteria:** the list looks like a card-based todo app in the
tab; narrow panes truncate cleanly (priority + `due:` never cut); resize
reflows immediately; saving `TODOS.md` refreshes sub-second.

## 10. Tests (`test.mjs`)

Strategy: existing tests are pipe-based (`spawnSync`, non-TTY) and assert on
substrings — they keep passing untouched because the non-TTY path is unchanged.
Add a new, clearly delimited block that mixes CLI-spawn checks (for flags) with
**direct-import unit checks** (for the renderer, avoiding any need to fake a
TTY).

### 10.1 Regression — non-TTY is byte-stable (CLI)
- Build a fixture `TODOS.md`, capture `run(["list"], dir).out` once (pre-change)
  as a golden string; after change assert equality. Covers both the task text
  and the flat (no-header) shape.

### 10.2 Regression — `--plain` reproduces old TTY format (unit)
- Since tests can't easily make `spawnSync` a TTY, import `renderList` directly:
  `renderList(sections, { mode: "grouped", color: false, ascii: false, density:
  "normal", all: false })` must equal the string that today's `cmdList` TTY
  branch produces (`todo.mjs:193-194`). Assert no `\x1b` bytes present.

### 10.3 Flag semantics (CLI + unit)
- `NO_COLOR=1 todo list` (spawned with that env) output contains **no** `\x1b`
  bytes, and equals `--color never` output.
- `--color always` output contains `\x1b` bytes even when spawned (non-TTY).
- `--ascii` output contains `[ ]` / `[x]` and **no** `☐` / `✓`.
- `--plain` output contains **no** `\x1b` bytes and uses `## ` section headers.
- `renderTaskStyled` with `color:true` wraps the `(A)` token in red+bold SGR;
  with `color:false` returns a string with zero `\x1b` bytes but still starts
  with the `☐` glyph; with `ascii:true` starts with `[ ]`.

### 10.4 Integrity (unit)
- `(A)` literal is always present in output regardless of color/ascii mode
  (meaning is never color-only).
- Open-task `t:` is never rendered (neither plain nor styled), matching
  `todo.mjs:203-205`.
- Done tasks (`all:true`) keep their `t:` tag; rendered with strikethrough when
  `color:true`.

### 10.5 Phase 2 additions (unit)
- `dueState("YYYY-MM-DD", today)` returns the right bucket for overdue / soon /
  normal (inject `today` — that's why it's a parameter, not `new Date()`).
- `truncate("long clean text", 8)` → `long cl…`; `visibleLen` of any styled
  string equals the length of its `stripAnsi`.
- `box()` wide layout contains `┌`/`└`; narrow (`width<60`) layout contains
  neither side border.

### 10.6 Existing suite
- No existing assertion is changed. The `module import` check
  (`test.mjs:141-145`) still passes (we only add exports to `todo-ui.mjs`, not
  remove any from `todo.mjs`).

## 11. Acceptance criteria
1. `node test.mjs` is green (existing + new cases).
2. `todo list | cat` is **byte-identical** to the pre-change output (golden
   diff). `todo count` unchanged.
3. In a real terminal: `todo list` shows glyphs, priority colors, dimmed tags,
   section titles; `NO_COLOR=1 todo list` shows the same layout without color;
   `--plain` shows the old grouped text; `--ascii` shows `[ ]` boxes.
4. The `todo` tab (`todo open`) shows the header bar (`N open · sections · ↻ Ns`),
   the styled list, and a dimmed footer; saving `TODOS.md` updates it (≤4 s in
   Phase 1, sub-second via `fs.watch` in Phase 2); resizing the tab reflows.
5. The tab uses the alt screen (scrollback is not polluted); `Ctrl-C` / pane
   close restores the main buffer cleanly.
6. No new entries in `package.json` `dependencies`/`devDependencies`.
7. `adapters/**` and the opencode `/todo` slash command still work (they consume
   the pipe-stable engine output).

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Refactor changes pipe output and breaks tests/scripts/toasts | `renderTaskPlain` is a verbatim extraction; golden-diff regression test (§10.1); non-TTY forced to `"flat"` mode. |
| Box/glyph missing on some font over SSH | `--ascii` fallback + `NO_COLOR` keeps glyphs but drops color; never encode meaning by color alone (`(A)` literal always present). |
| Narrow pane truncates priority/due | Truncation targets `clean` first, then drops `+proj`/`@ctx`; `(A)` and `due:` are never cut (§5.5); auto-`compact` under 60 cols. |
| Alt screen leaks on crash / pane kill | `SIGINT`/`SIGTERM` handlers emit `\x1b[?1049l`; alt screen is best-effort and the host tab close also resets the buffer. |
| `fs.watch` unreliable on network FS / some editors | Keep the interval timer as the authoritative fallback (§7.5); `fs.watch` is an optimization, not a dependency. |
| Scope creep into interactive TUI | Explicitly out of scope (§13); the pane is display-only by design (`herdr-todo.mjs:637`). |
| Two-spawn-per-tick overhead | Eliminated by in-process import (§7.1). |

## 13. Out of scope (noted for later, not in this plan)
- **Phase 3** optional `gum`/`glow` enhancement (`.plans/visual-todo.md` §5 Phase 3).
- Interactive flows: `fzf`/`gum choose` for `todo done --pick`. The plugin tab
  is display-only (`herdr-todo.mjs:637`); these are CLI-only future work.
- Wiring the parsed-but-unused `--section`/`--project`/`--context` filters in
  `cmdList` (`todo.mjs:182`) — unrelated to appearance.
- A date-grouped "today / overdue / upcoming" view.
- Changes to `herdr-plugin.toml` pane command (e.g. `--density compact`).
- Any change to `adapters/**` or the `/todo` slash command.
- Configurable color themes / user-tunable palette.

## 14. Open decisions (defaults proposed; confirm before implementing)
1. **`(A)` lines bold?** Propose yes in Phase 2 (whole row bold for top priority)
   so high-priority tasks pop in `NO_COLOR` mode too.
2. **Pane default density.** Propose `normal` everywhere, auto-`compact` under
   60 cols (§5.4).
3. **Due date in plain mode.** Propose appending `!` to an overdue `due:` token
   when `color === false`, so the urgency signal survives `NO_COLOR`/pipes.
4. **`↻` glyph under `--plain`.** Propose keeping unicode unless `--ascii`
   (plain is about "no ANSI", not "no unicode").
5. **Local vs UTC for `dueState`.** Propose **local** date for the day boundary
   (display concern), distinct from the engine's UTC done-stamping
   (`todo.mjs:123`).
