#!/usr/bin/env node
// Minimal engine test suite for herdr-todo (todo.mjs). Run: node test.mjs
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ENGINE = join(import.meta.dirname, "todo.mjs");
let failures = 0;

function run(args, cwd) {
  const r = spawnSync("node", [ENGINE, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

function withProject(fn) {
  const dir = mkdtempSync(join(tmpdir(), "herdr-todo-"));
  fn(dir);
  rmSync(dir, { recursive: true, force: true });
}

console.log("init/add/list/status/done/open");
withProject((dir) => {
  let r = run(["init"], dir);
  check("init creates TODOS.md", r.code === 0 && /created/.test(r.out), r.out);

  r = run(["add", "(A) First task @server +p0 due:2026-01-15"], dir);
  check("add returns success", r.code === 0, r.err);

  r = run(["add", "(B) Second task @client +p1"], dir);
  check("add second", r.code === 0, r.err);

  r = run(["status"], dir);
  check("status shows 2 open", /2 open/.test(r.out), r.out);

  r = run(["list"], dir);
  check("list shows both", r.out.includes("First task") && r.out.includes("Second task"), r.out);

  r = run(["done", "First"], dir);
  check("done by substring", r.code === 0 && /done: First task/.test(r.out), r.err + r.out);

  let file = readFileSync(join(dir, "TODOS.md"), "utf8");
  check("done task is [x] with t:", /\[x\] .* t:\d{4}/.test(file), file);

  r = run(["status"], dir);
  check("status shows 1 open after done", /1 open/.test(r.out), r.out);

  r = run(["open", "First"], dir);
  check("reopen", r.code === 0 && /reopened: First task/.test(r.out), r.out);

  r = run(["status"], dir);
  check("status shows 2 after reopen", /2 open/.test(r.out), r.out);

  file = readFileSync(join(dir, "TODOS.md"), "utf8");
  check("done task moved to ## Done", file.includes("## Done"), file);
});

console.log("discovery (walk up to parent)");
withProject((dir) => {
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(dir, "TODOS.md"), "# TODOS\n\n## Backlog\n");
  run(["add", "(A) Nested task"], dir);
  const r = run(["list"], sub);
  check("finds TODOS.md from subdir", r.code === 0 && r.out.includes("Nested task"), r.out);
});

console.log("error handling");
withProject((dir) => {
  const r = run(["list"], dir);
  check("list without TODOS.md errors", r.code !== 0, r.out);
});

console.log("count");
withProject((dir) => {
  run(["init"], dir);
  run(["add", "(A) X"], dir);
  run(["add", "(B) Y"], dir);
  const r = run(["count"], dir);
  check("count returns 2", r.out === "2", r.out);
});

console.log("module import");
{
  const r = spawnSync("node", ["-e", "import('" + ENGINE + "').then(m=>console.log(typeof m.countOpen))"], { encoding: "utf8" });
  check("exports countOpen", r.stdout.trim() === "function", r.stdout);
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}