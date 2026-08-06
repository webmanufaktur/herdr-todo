#!/usr/bin/env node
// todo-watch — live-updating todo list pane (in-process engine + ANSI UI).
// Usage: node todo-watch.mjs [interval_s] [--all] [--density m] [--color m]
//                          [--ascii] [--plain] [--file PATH]   (PATH or $TODOS_FILE)
//
// Payload for `todo open` (a dedicated Herdr TODO tab per present todo file).
// on file changes (fs.watch) with a periodic safety fallback. Renders into the
// NORMAL screen buffer (no alternate screen), so the pane scrolls naturally via
// the terminal's own scrollback and never shows buffer garbage while scrolling.
// Repaints are skipped when the frame is byte-identical, so a quiet pane does
// not spam scrollback with copies.

import { readFileSync, watch as fsWatch, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { findTodos, parse, openTasks } from "./todo.mjs";
import {
  resolveOptions,
  renderList,
  renderHeader,
  renderFooter,
} from "./todo-ui.mjs";

// ---- args ------------------------------------------------------------------

function parseWatchArgs(argv) {
  const out = { interval: 4, noAltScreen: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (/^\d+$/.test(a)) out.interval = Number(a);
    else if (a === "--all") out.all = true;
    else if (a === "--plain") out.plain = true;
    else if (a === "--ascii") out.ascii = true;
    else if (a === "--file") out.file = argv[++i];
    else if (a === "--color") out.color = argv[++i];
    else if (a === "--density") out.density = argv[++i];
  }
  return out;
}

const watchArgs = parseWatchArgs(process.argv.slice(2));
const interval = watchArgs.interval;
const opts = resolveOptions(process.env, watchArgs, true);

// Optional explicit file (--file PATH or $TODOS_FILE, e.g. an example.md);
// otherwise discover TODOS.md/TODO.md walking up from cwd.
const fileOverride =
  watchArgs.file || process.env.TODOS_FILE || process.env.TODO_FILE || null;

function findTodosFile() {
  if (fileOverride) {
    const p = fileOverride.startsWith("/")
      ? fileOverride
      : join(process.cwd(), fileOverride);
    return existsSync(p) ? p : null;
  }
  return findTodos(process.cwd());
}

let todosFile = findTodosFile();
let cursorHidden = false;
let lastGoodFrame = "";
let watchHandle = null;
let debounceTimer = null;

// ---- frame -----------------------------------------------------------------

function computeMeta(sections) {
  const perSection = sections.map((s) => ({
    title: s.title,
    open: s.tasks.filter((t) => t.open).length,
  }));
  const open = openTasks(sections).length;
  const doneCount = sections.reduce(
    (n, s) => n + s.tasks.filter((t) => !t.open).length,
    0,
  );
  return {
    open,
    perSection,
    interval,
    all: !!opts.all,
    doneCount,
    file: basename(todosFile || fileOverride || "TODOS.md"),
  };
}

function buildFrame() {
  if (!todosFile || !existsSync(todosFile)) {
    todosFile = findTodosFile();
  }
  if (!todosFile) {
    return fileOverride
      ? `no file found at ${fileOverride} (cwd: ${process.cwd()})`
      : "no TODOS.md or TODO.md found\n\n(edit TODOS.md — updates here automatically)";
  }

  let sections;
  try {
    sections = parse(readFileSync(todosFile, "utf8"));
  } catch (err) {
    // Keep last good frame; surface a one-line banner if nothing yet
    if (lastGoodFrame) return lastGoodFrame;
    return `error reading ${todosFile}: ${err.message}`;
  }

  opts.width = process.stdout.columns || 80;
  const meta = computeMeta(sections);
  const list = renderList(sections, opts);
  const header = renderHeader(meta, opts);
  const footer = renderFooter(meta, opts);
  const body = list.trim() || "no open todos. 🎉";
  const frame = header + "\n\n" + body + "\n\n" + footer;
  return frame;
}

function writeFrame(frame) {
  if (!cursorHidden) {
    process.stdout.write("\x1b[?25l"); // hide cursor
    cursorHidden = true;
  }
  // cursor home + clear from cursor to end (scrollback is preserved)
  process.stdout.write("\x1b[H\x1b[J");
  process.stdout.write(frame);
}

function draw() {
  const frame = buildFrame();
  // Skip repaints when nothing changed — keeps the normal-buffer scrollback
  // free of duplicate copies while still refreshing on real changes.
  if (frame === lastGoodFrame) return;
  lastGoodFrame = frame;
  writeFrame(frame);
}

function cleanup() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (watchHandle) {
    try {
      watchHandle.close();
    } catch {
      /* ignore */
    }
  }
  if (cursorHidden) {
    process.stdout.write("\x1b[?25h"); // show cursor
    cursorHidden = false;
  }
}

// ---- fs.watch (Phase 2) + timer fallback -----------------------------------

function debouncedDraw() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // File may have been deleted/recreated — re-discover and re-arm watch
    const next = findTodosFile();
    if (next && next !== todosFile) {
      todosFile = next;
      armWatch();
    } else if (!next) {
      todosFile = null;
    }
    draw();
  }, 120);
}

function armWatch() {
  if (watchHandle) {
    try {
      watchHandle.close();
    } catch {
      /* ignore */
    }
    watchHandle = null;
  }
  if (!todosFile || !existsSync(todosFile)) return;
  try {
    watchHandle = fsWatch(todosFile, () => debouncedDraw());
    if (typeof watchHandle.on === "function") {
      watchHandle.on("error", () => {
        // Editor atomic renames can invalidate the watch — re-arm on next tick
        setTimeout(armWatch, 200);
      });
    }
  } catch {
    // fs.watch unavailable — timer is the backup
  }
}

// ---- start -----------------------------------------------------------------

draw();
armWatch();
setInterval(draw, interval * 1000);

process.on("SIGWINCH", draw);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
