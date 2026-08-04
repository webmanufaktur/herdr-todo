#!/usr/bin/env node
// herdr-todo — portable TODOS.md engine (todo.txt markup in a Markdown file).
// Zero dependencies. This file is both:
//   - the `todo` CLI (list / add / done / open / status / next / init)
//   - the engine behind the herdr-todo Herdr plugin (via the adapters/launcher)
//
// Format — a single TODOS.md or TODO.md at the project root (walked up from cwd):
//
//   # TODOS
//
//   > **How to use this file** — every todo file starts with these instructions
//   > (written by `todo init`; `todo add` also writes them for a fresh file).
//
//   ## P0 — Do first            ← GROUPNAME (a group of related work)
//
//   ### FEATURENAME              ← feature bucket: tasks that belong together
//   - [ ] (A) Add security headers @server +p0 due:2026-01-15
//
//   ### BACKLOG                  ← example feature name (uncategorized ideas)
//   - [ ] (B) Maybe add a dark mode @client +p1
//
//   ## Done                      ← closed group at the bottom (completed tasks)
//   - [x] (A) Security headers @server +p0 t:2026-01-10
//
// Groups are `## HEADING`. Inside a group, `### FEATURENAME` headings name
// feature buckets (any name works — `### BACKLOG` is just a common one for
// uncategorized ideas); task lines live under a `###` heading. Task lines are
// GitHub task-list checkboxes (`- [ ]` / `- [x]`) with todo.txt metadata tags:
// `(A)`..`(Z)` priority, `+project`/`+section`, `@context`, `due:YYYY-MM-DD`,
// `t:YYYY-MM-DD` (done date).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { renderList, renderTaskPlain, resolveOptions } from "./todo-ui.mjs";

const FILE_NAME = "TODOS.md";
// Accepted names, in preference order. `todo init` still writes FILE_NAME.
const FILE_NAMES = ["TODOS.md", "TODO.md"];
const DEFAULT_SECTION = "Backlog";

// ---- discovery ------------------------------------------------------------

function findTodos(startDir) {
  let dir = startDir;
  for (;;) {
    for (const name of FILE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---- parsing ---------------------------------------------------------------
// Returns { sections: [{title, tasks: [{raw, index, open, priority, tags, clean}]}], doneSection }

function parse(text) {
  const sections = [];
  let current = { title: DEFAULT_SECTION, tasks: [] };
  const lines = text.split("\n");
  for (const line of lines) {
    const sec = line.match(/^##\s+(.+)$/);
    if (sec) {
      current = { title: sec[1].trim(), tasks: [] };
      sections.push(current);
      continue;
    }
    const m = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (m) {
      const body = m[2];
      const open = m[1].toLowerCase() === " ";
      const prio = body.match(/^\(([A-Z])\)\s*/);
      const tags = [...body.matchAll(/(?:^|\s)(\+[^\s]+|@[^\s]+|due:[\d-]+|t:[\d-]+)/g)].map((x) => x[1]);
      const clean = tagless(body);
      current.tasks.push({ raw: line, open, priority: prio ? prio[1] : null, tags, clean });
      continue;
    }
    // ignore non-task lines (headings, blank, prose)
  }
  return sections;
}

function tagless(body) {
  return body
    .replace(/^\(([A-Z])\)\s*/, "")
    .replace(/\s+(\+[^\s]+|@[^\s]+|due:[\d-]+|t:[\d-]+)/g, "")
    .trim();
}

function openTasks(sections) {
  return sections.flatMap((s) => s.tasks.filter((t) => t.open).map((t) => ({ ...t, section: s.title })));
}

function findTask(sections, ref) {
  const open = openTasks(sections);
  if (/^\d+$/.test(ref)) {
    const i = Number(ref) - 1;
    if (i >= 0 && i < open.length) return open[i];
    return { error: `no open task #${ref} (have ${open.length})` };
  }
  const matches = open.filter((t) => t.clean.toLowerCase().includes(ref.toLowerCase()));
  if (matches.length === 0) return { error: `no open task matching "${ref}"` };
  if (matches.length > 1) return { error: `ambiguous "${ref}" matches: ${matches.map((t) => '"' + t.clean + '"').join(", ")}` };
  return matches[0];
}

// ---- mutate ----------------------------------------------------------------

function applyChange(text, target, fn) {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === target.raw) {
      lines[i] = fn(lines[i]);
      return { text: lines.join("\n"), changed: true };
    }
  }
  return { text, changed: false };
}

function toDone(raw) {
  return raw.replace(/^[-*]\s+\[[ xX]\]/, "- [x]");
}

function toOpen(raw) {
  return raw.replace(/^[-*]\s+\[[ xX]\]/, "- [ ]");
}

function stampDone(raw) {
  const today = new Date().toISOString().slice(0, 10);
  if (/\st:\d{4}-\d{2}-\d{2}/.test(raw)) {
    return raw.replace(/\s+t:\d{4}-\d{2}-\d{2}/, ` t:${today}`);
  }
  return raw + ` t:${today}`;
}

// Remove completion date stamp (used when reopening a done task).
function stripDoneStamp(raw) {
  return raw.replace(/\s+t:\d{4}-\d{2}-\d{2}/g, "");
}

// Insert a task line at the end of the first section whose heading is not
// "Done" (the top of the list); appends a new group if none exists.
// New tasks simply land at the end of the top group's body.
function insertIntoSection(text, line) {
  const lines = text.split("\n");
  const newLines = [];
  let inOpenSection = false;
  let inserted = false;
  for (const l of lines) {
    const sec = l.match(/^##\s+(.+)$/);
    if (sec) {
      if (inOpenSection && !inserted) {
        newLines.push(line);
        // keep one blank line between the last task and the next group heading
        if (newLines[newLines.length - 1] !== "") newLines.push("");
        inserted = true;
      }
      inOpenSection = sec[1].trim().toLowerCase() !== "done";
    }
    newLines.push(l);
  }
  if (!inserted) {
    if (inOpenSection) {
      newLines.push(line);
    } else {
      newLines.push("", `## ${DEFAULT_SECTION}`, line);
    }
  }
  return newLines.join("\n");
}

// Move a task line into the ## Done section (or create it).
function moveToDoneSection(text, raw, changed) {
  const lines = text.split("\n");
  const doneIdx = lines.findIndex((l) => /^##\s+done\s*$/i.test(l.trim()));
  if (doneIdx === -1) {
    const appended = lines.filter((l) => l !== raw);
    return normalizeBlank(appended.concat("", "## Done", "", changed).join("\n"));
  }
  const afterDone = lines.slice(doneIdx + 1).filter((l) => !l.startsWith("## "));
  const before = lines.slice(0, doneIdx + 1).filter((l) => l !== raw);
  const trailing = lines.slice(doneIdx + 1).filter((l) => l.startsWith("## "));
  return normalizeBlank(
    before.concat(...afterDone.filter(Boolean), "", changed, ...trailing).join("\n"),
  );
}

// Cosmetic: collapse 3+ blank lines into one, and keep the `## Done` heading on
// its own paragraph (blank line after the heading, before the first task).
function normalizeBlank(text) {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/(^|\n)(## Done)(\n)(?=\S)/, "$1$2$3\n");
}

// ---- commands --------------------------------------------------------------

function cmdList(args) {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found (walked up from cwd). Run: todo init");
  // section/project/context are parsed but not yet applied (filters out of scope)
  const sections = parse(readFileSync(file, "utf8"));
  const opts = resolveOptions(process.env, args, !!process.stdout.isTTY);
  opts.width = process.stdout.columns || 80;
  const out = renderList(sections, opts);
  return out.trim() || "no open todos. 🎉";
}

// Thin re-export: byte-stable plain path lives in todo-ui.mjs
function renderTask(t) {
  return renderTaskPlain(t);
}

function cmdStatus() {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found. Run: todo init");
  const sections = parse(readFileSync(file, "utf8"));
  const lines = [];
  let total = 0;
  for (const s of sections) {
    const open = s.tasks.filter((t) => t.open).length;
    if (open === 0) continue;
    total += open;
    lines.push(`${s.title}: ${open}`);
  }
  if (total === 0) return "no open todos. 🎉";
  return `${total} open\n` + lines.join("\n");
}

function cmdAdd(body) {
  const file = findTodos(process.cwd()) || join(process.cwd(), FILE_NAME);
  let text = "";
  if (existsSync(file)) text = readFileSync(file, "utf8");
  const line = `- [ ] ${body.trim()}`;
  text = insertIntoSection(text, line);
  writeFileSync(file, text, "utf8");
  return `added: ${line}`;
}

function cmdDone(ref) {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found.");
  const text = readFileSync(file, "utf8");
  const sections = parse(text);
  const t = findTask(sections, ref);
  if (t.error) return fail(t.error);
  const changed = stampDone(toDone(t.raw));
  const res = moveToDoneSection(text, t.raw, changed);
  if (res === text) return fail("could not edit task");
  writeFileSync(file, res, "utf8");
  return `done: ${t.clean}`;
}

function cmdOpen(ref) {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found.");
  const text = readFileSync(file, "utf8");
  const sections = parse(text);
  const all = sections.flatMap((s) => s.tasks).filter((t) => !t.open);
  const matches = all.filter((t) => t.clean.toLowerCase().includes(ref.toLowerCase()));
  if (matches.length === 0) return fail(`no done task matching "${ref}"`);
  if (matches.length > 1) return fail(`ambiguous: ${matches.map((t) => t.clean).join(", ")}`);
  // Reopen: clear checkbox AND strip the done-date stamp so open tasks never
  // carry a stale t:YYYY-MM-DD (todo.txt completion date is done-only).
  const res = applyChange(text, matches[0], (raw) => stripDoneStamp(toOpen(raw)));
  if (!res.changed) return fail("could not edit task");
  writeFileSync(file, res.text, "utf8");
  return `reopened: ${matches[0].clean}`;
}

function cmdNext() {
  const file = findTodos(process.cwd());
  if (!file) return fail("no TODOS.md or TODO.md found.");
  const sections = parse(readFileSync(file, "utf8"));
  const open = openTasks(sections);
  if (open.length === 0) return "no open todos. 🎉";
  open.sort((a, b) => (a.priority ?? "Z").localeCompare(b.priority ?? "Z"));
  const t = open[0];
  return `(${t.priority ?? "?"}) ${t.clean}  [${t.section}]`;
}

// The standard file template: usage instructions + the two-level layout
// (## GROUPNAME → ### FEATURENAME feature buckets, then ## Done).
// Every TODO.md / TODOS.md carries this header so the format is self-describing.
function template() {
  return `# TODOS

> **How to use this file**
> - \`## GROUPNAME\` — a group of related work (e.g. \`P0 — Do first\`). Open groups at the top, \`## Done\` at the bottom.
> - \`### FEATURENAME\` — a feature bucket inside a group; name it however you like
>   (e.g. \`### BACKLOG\` for uncategorized ideas). Tasks live under a \`###\` heading.
> - Tasks are \`- [ ]\` (open) / \`- [x]\` (done) lines, with optional
>   \`(A)\`–\`(Z)\` priority, \`+project\`/\`@context\` tags and \`due:YYYY-MM-DD\`.
>   Completing stamps \`t:YYYY-MM-DD\` (done date) automatically.
> - Manage with \`todo\` (list/add/done/open/status/next/init) — never hand-edit task lines.
>
> Example: \`- [ ] (A) Add security headers @server +p0 due:2026-01-15\`

## P0 — Do first

### FEATURENAME

## P1 — Should do

### FEATURENAME

## Done
`;
}

function cmdInit() {
  const file = join(process.cwd(), FILE_NAME);
  if (existsSync(file)) return fail(`${file} already exists`);
  writeFileSync(file, template(), "utf8");
  return `created ${file}`;
}

function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

// ---- CLI --------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);

function runCli() {
  switch (cmd) {
    case "list": return console.log(cmdList(parseArgs(rest)));
    case "status": return console.log(cmdStatus());
    case "add": return console.log(cmdAdd(rest.join(" ")));
    case "done": return console.log(cmdDone(rest.join(" ")));
    case "open": return console.log(cmdOpen(rest.join(" ")));
    case "next": return console.log(cmdNext());
    case "init": return console.log(cmdInit());
    case "count": return console.log(countOpen());
    default:
      console.log(usage());
      process.exit(cmd ? 2 : 0);
  }
}

function countOpen() {
  const file = findTodos(process.cwd());
  if (!file) return "0";
  const sections = parse(readFileSync(file, "utf8"));
  return String(openTasks(sections).length);
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") out.all = true;
    else if (a === "--plain") out.plain = true;
    else if (a === "--ascii") out.ascii = true;
    else if (a === "--section") out.section = args[++i];
    else if (a === "--project") out.project = args[++i];
    else if (a === "--context") out.context = args[++i];
    else if (a === "--color") out.color = args[++i];
    else if (a === "--density") out.density = args[++i];
  }
  return out;
}

function usage() {
  return `todo — portable TODOS.md / TODO.md engine

Usage:
  todo list [flags]            List open tasks (styled in a TTY; flat when piped)
  todo status                  Open counts per group
  todo add "<text>" [(A)] [+sec] [@ctx] [due:YYYY-MM-DD]
  todo done <id|text>          Mark done (moves to [x] + stamps t:)
  todo open <text>             Reopen a done task
  todo next                    Top-priority open task
  todo init                    Create a TODOS.md in cwd
  todo count                   Number of open tasks (for scripts/sidebar)

List flags:
  --all                        Include done tasks
  --plain                      Old grouped plain text (no ANSI, no glyphs)
  --ascii                      ASCII glyph fallback ([ ], +, |)
  --color always|auto|never    Color control (default: auto; honors NO_COLOR / FORCE_COLOR)
  --density compact|normal|relaxed   Spacing (default: normal; auto-compact under 60 cols)

Looks for TODOS.md or TODO.md walking up from cwd (TODOS.md preferred).
`;
}

// Module API for the herdr plugin (and adapter scripts).
export { findTodos, parse, openTasks, countOpen, FILE_NAME, FILE_NAMES, DEFAULT_SECTION };

// Run the CLI only when executed directly (not when imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === "file://" + process.argv[1];
if (isDirectRun) runCli();