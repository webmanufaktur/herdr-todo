#!/usr/bin/env node
// todo-watch — live-updating todo list pane. Clears and re-renders `todo list`
// every few seconds so the pane stays in sync with TODOS.md changes.
// Usage: node todo-watch.mjs [interval_s] [--all]
//
// This is the payload for `todo open` (a Herdr right-hand pane). It reads the
// project's TODOS.md via the engine and re-renders on a timer.

import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(__dirname, "todo.mjs");

const args = process.argv.slice(2);
const interval = Number(args.find((a) => /^\d+$/.test(a)) || 4);
const all = args.includes("--all");

const LIST = all ? ["list", "--all"] : ["list"];

function render() {
  const r = spawnSync("node", [ENGINE, ...LIST], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout : r.stderr || "no TODOS.md found";
  return out.trim();
}

function clear() {
  process.stdout.write("\x1b[2J\x1b[H");
}

function title() {
  const file = spawnSync("node", [ENGINE, "count"], { encoding: "utf8" });
  const n = file.status === 0 ? file.stdout.trim() : "0";
  return `${n} open todo${n === "1" ? "" : "s"}  —  TODOS.md  (refresh every ${interval}s)`;
}

function draw() {
  clear();
  process.stdout.write("\x1b[1m" + title() + "\x1b[0m\n\n");
  process.stdout.write(render() + "\n\n");
  process.stdout.write("(edit TODOS.md and it updates here automatically)");
}

draw();
setInterval(draw, interval * 1000);

// Also redraw immediately on SIGWINCH (terminal resize).
process.on("SIGWINCH", draw);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));