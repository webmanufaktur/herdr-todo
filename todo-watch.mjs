#!/usr/bin/env node
// todo-watch — live-updating todo list pane (in-process engine + ANSI UI).
// Usage: node todo-watch.mjs [interval_s] [--all] [--density m] [--color m]
//                          [--ascii] [--plain] [--no-alt-screen]
//
// Payload for `todo open` (Herdr tab labeled "todo"). Renders via todo-ui.mjs
// on a timer, with fs.watch for sub-second refresh and alt-screen to avoid
// scrollback flicker.

import { readFileSync, watch as fsWatch, existsSync } from "node:fs";
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
    else if (a === "--no-alt-screen") out.noAltScreen = true;
    else if (a === "--color") out.color = argv[++i];
    else if (a === "--density") out.density = argv[++i];
  }
  return out;
}

const watchArgs = parseWatchArgs(process.argv.slice(2));
const interval = watchArgs.interval;
const opts = resolveOptions(process.env, watchArgs, true);

let todosFile = findTodos(process.cwd());
let altScreenOn = false;
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
  };
}

function buildFrame() {
  todosFile = todosFile || findTodos(process.cwd());
  if (!todosFile || !existsSync(todosFile)) {
    todosFile = findTodos(process.cwd());
  }
  if (!todosFile) {
    return "no TODOS.md or TODO.md found\n\n(edit TODOS.md — updates here automatically)";
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
  lastGoodFrame = frame;
  return frame;
}

function writeFrame(frame) {
  if (!altScreenOn && !watchArgs.noAltScreen) {
    process.stdout.write("\x1b[?1049h"); // enter alt screen
    process.stdout.write("\x1b[?25l"); // hide cursor
    altScreenOn = true;
  }
  // cursor home + clear from cursor to end (less flicker than full clear)
  process.stdout.write("\x1b[H\x1b[J");
  process.stdout.write(frame);
}

function draw() {
  writeFrame(buildFrame());
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
  if (altScreenOn) {
    process.stdout.write("\x1b[?25h"); // show cursor
    process.stdout.write("\x1b[?1049l"); // leave alt screen
    altScreenOn = false;
  }
}

// ---- fs.watch (Phase 2) + timer fallback -----------------------------------

function debouncedDraw() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    // File may have been deleted/recreated — re-discover and re-arm watch
    const next = findTodos(process.cwd());
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
