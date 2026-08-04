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

console.log("discovery (TODO.md alias)");
withProject((dir) => {
  const sub = join(dir, "a", "b");
  mkdirSync(sub, { recursive: true });
  writeFileSync(
    join(dir, "TODO.md"),
    "# TODO\n\n## Backlog\n- [ ] (A) Alias task @server +p0\n",
    "utf8",
  );
  const r = run(["list"], sub);
  check("finds TODO.md from subdir", r.code === 0 && r.out.includes("Alias task"), r.out);
  const count = run(["count"], dir);
  check("count works on TODO.md", count.out === "1", count.out);
});

console.log("discovery (TODOS.md preferred over TODO.md)");
withProject((dir) => {
  writeFileSync(join(dir, "TODO.md"), "# TODO\n\n## Backlog\n- [ ] (A) From TODO.md\n", "utf8");
  writeFileSync(join(dir, "TODOS.md"), "# TODOS\n\n## Backlog\n- [ ] (A) From TODOS.md\n", "utf8");
  const r = run(["list"], dir);
  check("prefers TODOS.md when both exist", r.out.includes("From TODOS.md") && !r.out.includes("From TODO.md"), r.out);
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

console.log("done-date (t:) logic");
withProject((dir) => {
  run(["init"], dir);
  run(["add", "(A) Stamp me"], dir);
  run(["done", "Stamp"], dir);
  let file = readFileSync(join(dir, "TODOS.md"), "utf8");
  check("done stamps t:", /\[x\] .* t:\d{4}-\d{2}-\d{2}/.test(file), file);

  const r = run(["open", "Stamp"], dir);
  check("reopen ok", r.code === 0, r.err + r.out);
  file = readFileSync(join(dir, "TODOS.md"), "utf8");
  check("reopen strips t:", /\[ \] .*Stamp me/.test(file) && !/Stamp me.*t:\d{4}/.test(file), file);

  // Stale open+t: (hand-edit / old bug): still counts open, list hides t:
  writeFileSync(
    join(dir, "TODOS.md"),
    `# TODOS\n\n## Backlog\n- [ ] (B) Stale stamp task +p1 t:2026-08-03\n\n## Done\n`,
    "utf8",
  );
  const list = run(["list"], dir);
  check("open+t: still listed", list.out.includes("Stale stamp task"), list.out);
  check("open+t: list hides done stamp", !/t:2026-08-03/.test(list.out), list.out);
  const count = run(["count"], dir);
  check("open+t: counts as open", count.out === "1", count.out);
});

console.log("module import");
{
  const r = spawnSync("node", ["-e", "import('" + ENGINE + "').then(m=>console.log(typeof m.countOpen))"], { encoding: "utf8" });
  check("exports countOpen", r.stdout.trim() === "function", r.stdout);
}

// ---------------------------------------------------------------------------
// Display / plain / color contracts (todo-ui.mjs + list flags)
// ---------------------------------------------------------------------------
console.log("display / plain / color");
{
  const UI = join(import.meta.dirname, "todo-ui.mjs");
  const {
    resolveOptions,
    resolveColor,
    renderTaskPlain,
    renderTaskStyled,
    renderList,
    renderHeader,
    renderFooter,
    c,
    glyph,
    truncate,
    visibleLen,
    stripAnsi,
    dueState,
    box,
  } = await import(UI);

  // --- 10.1 Regression: non-TTY list is flat + byte-stable shape ---
  withProject((dir) => {
    writeFileSync(
      join(dir, "TODOS.md"),
      `# TODOS

## P0 — Do first
- [ ] (A) Add security headers @server +p0 due:2026-01-15

## P1 — Should do
- [ ] (B) Split api @client +p1

## Done
- [x] (A) Old thing @server +p0 t:2026-01-10
`,
      "utf8",
    );
    const r = run(["list"], dir);
    const expected =
      "(A) Add security headers  @server +p0 due:2026-01-15\n" +
      "(B) Split api  @client +p1";
    check("flat list golden (non-TTY)", r.out === expected, r.out);
    check("flat list has no ANSI", !r.out.includes("\x1b"), r.out);
    check("flat list has no section headers", !r.out.includes("## "), r.out);
    check("count still numeric", run(["count"], dir).out === "2", run(["count"], dir).out);
  });

  // --- 10.2 Regression: --plain / grouped mode matches old TTY format ---
  {
    const sections = [
      {
        title: "P0 — Do first",
        tasks: [
          {
            raw: "- [ ] (A) Add security headers @server +p0",
            open: true,
            priority: "A",
            tags: ["@server", "+p0"],
            clean: "Add security headers",
          },
        ],
      },
      {
        title: "P1",
        tasks: [
          {
            raw: "- [ ] (B) Other @client",
            open: true,
            priority: "B",
            tags: ["@client"],
            clean: "Other",
          },
        ],
      },
    ];
    const grouped = renderList(sections, {
      mode: "grouped",
      color: false,
      ascii: false,
      density: "normal",
      all: false,
    });
    const expectedGrouped =
      "\n## P0 — Do first\n  (A) Add security headers  @server +p0\n\n## P1\n  (B) Other  @client";
    check("grouped mode matches old TTY", grouped === expectedGrouped, grouped);
    check("grouped has no ANSI", !grouped.includes("\x1b"), grouped);
  }

  // --- 10.3 Flag semantics ---
  withProject((dir) => {
    writeFileSync(
      join(dir, "TODOS.md"),
      `# TODOS\n\n## Backlog\n- [ ] (A) Color me @ctx +p0 due:2099-01-01\n`,
      "utf8",
    );

    const noColor = spawnSync("node", [ENGINE, "list"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined },
    });
    const never = spawnSync("node", [ENGINE, "list", "--color", "never"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined },
    });
    check(
      "NO_COLOR has no ANSI",
      !noColor.stdout.includes("\x1b"),
      noColor.stdout,
    );
    check(
      "NO_COLOR equals --color never",
      noColor.stdout.trim() === never.stdout.trim(),
      `NO_COLOR=${JSON.stringify(noColor.stdout)} never=${JSON.stringify(never.stdout)}`,
    );

    const always = spawnSync("node", [ENGINE, "list", "--color", "always"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined },
    });
    check(
      "--color always emits ANSI (even non-TTY)",
      always.stdout.includes("\x1b"),
      always.stdout,
    );

    const ascii = spawnSync("node", [ENGINE, "list", "--color", "always", "--ascii"], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: undefined },
    });
    check("--ascii uses [ ]", ascii.stdout.includes("[ ]"), ascii.stdout);
    check("--ascii has no ☐", !ascii.stdout.includes("☐"), ascii.stdout);
    check("--ascii has no ✓", !ascii.stdout.includes("✓"), ascii.stdout);

    const plain = spawnSync("node", [ENGINE, "list", "--plain"], {
      cwd: dir,
      encoding: "utf8",
    });
    check("--plain has no ANSI", !plain.stdout.includes("\x1b"), plain.stdout);
    check("--plain has ## headers", plain.stdout.includes("## "), plain.stdout);
  });

  // renderTaskStyled unit checks
  {
    const taskA = {
      open: true,
      priority: "A",
      tags: ["@server", "+p0", "due:2099-06-01"],
      clean: "Add security headers",
    };
    const colored = renderTaskStyled(taskA, {
      color: true,
      ascii: false,
      density: "normal",
      width: 120,
    });
    check(
      "styled (A) is bold red SGR",
      colored.includes("\x1b[1;31m") || colored.includes("\x1b[1m"),
      colored,
    );
    check("styled (A) literal present", colored.includes("(A)"), colored);

    const noCol = renderTaskStyled(taskA, {
      color: false,
      ascii: false,
      density: "normal",
      width: 120,
    });
    check("styled color:false no ANSI", !noCol.includes("\x1b"), noCol);
    check("styled color:false keeps ☐", noCol.startsWith("☐"), noCol);
    check("styled color:false keeps (A)", noCol.includes("(A)"), noCol);

    const asciiLine = renderTaskStyled(taskA, {
      color: false,
      ascii: true,
      density: "normal",
      width: 120,
    });
    check("styled ascii starts with [ ]", asciiLine.startsWith("[ ]"), asciiLine);
  }

  // --- 10.4 Integrity ---
  {
    const openWithT = {
      open: true,
      priority: "B",
      tags: ["+p1", "t:2026-08-03"],
      clean: "Stale stamp task",
    };
    check(
      "plain hides open t:",
      !renderTaskPlain(openWithT).includes("t:2026-08-03"),
      renderTaskPlain(openWithT),
    );
    check(
      "styled hides open t:",
      !renderTaskStyled(openWithT, { color: false, width: 80 }).includes("t:2026-08-03"),
      renderTaskStyled(openWithT, { color: false, width: 80 }),
    );

    const done = {
      open: false,
      priority: "A",
      tags: ["@server", "t:2026-01-10"],
      clean: "Finished",
    };
    check(
      "plain keeps done t:",
      renderTaskPlain(done).includes("t:2026-01-10"),
      renderTaskPlain(done),
    );
    const doneStyled = renderTaskStyled(done, { color: true, width: 80 });
    check("done styled has strikethrough", doneStyled.includes("\x1b[2;9m") || doneStyled.includes(";9m"), doneStyled);
    check("done styled keeps t:", stripAnsi(doneStyled).includes("t:2026-01-10"), doneStyled);
  }

  // --- 10.5 Phase 2: dueState, truncate, box, visibleLen ---
  {
    const today = new Date(2026, 7, 4); // 2026-08-04 local
    check("dueState overdue", dueState("2026-08-01", today) === "overdue");
    check("dueState soon (today)", dueState("2026-08-04", today) === "soon");
    check("dueState soon (+2)", dueState("2026-08-06", today) === "soon");
    check("dueState normal (+3)", dueState("2026-08-07", today) === "normal");

    check("truncate long", truncate("long clean text", 8) === "long cl…", truncate("long clean text", 8));
    check("truncate short", truncate("hi", 8) === "hi");

    const styled = c("hello", { color: true }, 31);
    check("visibleLen ignores ANSI", visibleLen(styled) === 5, String(visibleLen(styled)));
    check("stripAnsi works", stripAnsi(styled) === "hello", stripAnsi(styled));

    const wideBox = box("P0", ["task one"], 80, { color: false, ascii: false });
    check("box wide has ┌", wideBox.includes("┌"), wideBox);
    check("box wide has └", wideBox.includes("└"), wideBox);
    check("box wide has │", wideBox.includes("│"), wideBox);

    const narrowBox = box("P0", ["task one"], 40, { color: false, ascii: false });
    check("box narrow no │ sides", !narrowBox.includes("│"), narrowBox);
    check("box narrow has ─", narrowBox.includes("─"), narrowBox);

    // overdue due: appends ! when color false
    const overdueTask = {
      open: true,
      priority: "B",
      tags: ["due:2020-01-01", "@ctx"],
      clean: "Late work",
    };
    const plainDue = renderTaskStyled(overdueTask, {
      color: false,
      width: 80,
      today: new Date(2026, 7, 4),
    });
    check("overdue due: gets ! when no color", plainDue.includes("due:2020-01-01!"), plainDue);

    // truncation preserves (A) and due:
    const longClean = {
      open: true,
      priority: "A",
      tags: ["@ctx", "+proj", "due:2099-01-01"],
      clean: "This is a very long clean description that should be truncated eventually",
    };
    const truncLine = renderTaskStyled(longClean, {
      color: false,
      width: 50,
      density: "normal",
    });
    check("truncate keeps (A)", truncLine.includes("(A)"), truncLine);
    check("truncate keeps due:", truncLine.includes("due:2099-01-01"), truncLine);
    check("truncate has ellipsis or dropped tags", truncLine.includes("…") || !truncLine.includes("+proj"), truncLine);

    // resolveColor precedence
    check("resolveColor always", resolveColor("always", {}, false) === true);
    check("resolveColor never", resolveColor("never", {}, true) === false);
    check("resolveColor NO_COLOR", resolveColor("auto", { NO_COLOR: "" }, true) === false);
    check("resolveColor FORCE_COLOR", resolveColor("auto", { FORCE_COLOR: "1" }, false) === true);
    check("resolveColor TTY", resolveColor("auto", {}, true) === true);
    check("resolveColor non-TTY", resolveColor("auto", {}, false) === false);

    // resolveOptions mode
    check(
      "opts flat non-TTY",
      resolveOptions({}, {}, false).mode === "flat",
    );
    check(
      "opts styled TTY",
      resolveOptions({}, {}, true).mode === "styled",
    );
    check(
      "opts grouped --plain",
      resolveOptions({}, { plain: true }, true).mode === "grouped",
    );
    check(
      "opts styled --color always non-TTY",
      resolveOptions({}, { color: "always" }, false).mode === "styled",
    );

    // auto-compact under 60
    const auto = resolveOptions({}, {}, true);
    auto.width = 50;
    const listNarrow = renderList(
      [
        {
          title: "S",
          tasks: [{ open: true, priority: null, tags: [], clean: "x" }],
        },
      ],
      auto,
    );
    // compact still draws cards; just ensure it renders without throwing
    check("auto-compact narrow renders", listNarrow.includes("x"), listNarrow);

    // density relaxed has blank between tasks (more newlines)
    const twoTasks = [
      {
        title: "S",
        tasks: [
          { open: true, priority: null, tags: [], clean: "one" },
          { open: true, priority: null, tags: [], clean: "two" },
        ],
      },
    ];
    const compactL = renderList(twoTasks, {
      mode: "styled",
      color: false,
      density: "compact",
      densityExplicit: true,
      width: 80,
    });
    const relaxedL = renderList(twoTasks, {
      mode: "styled",
      color: false,
      density: "relaxed",
      densityExplicit: true,
      width: 80,
    });
    check(
      "relaxed has more newlines than compact",
      relaxedL.split("\n").length > compactL.split("\n").length,
      `relaxed=${relaxedL.split("\n").length} compact=${compactL.split("\n").length}`,
    );

    // header / footer smoke
    const hdr = renderHeader(
      { open: 2, perSection: [{ title: "P0", open: 2 }], interval: 4 },
      { color: false, ascii: false },
    );
    check("header has open count", hdr.includes("2 open"), hdr);
    check("header has refresh glyph", hdr.includes("↻") || hdr.includes("4s"), hdr);
    const ftr = renderFooter({ all: true, doneCount: 3 }, { color: false });
    check("footer shows done count when --all", ftr.includes("showing 3 done"), ftr);

    // glyph ascii
    check("glyph open unicode", glyph("open", { ascii: false }) === "☐");
    check("glyph open ascii", glyph("open", { ascii: true }) === "[ ]");
  }
}

console.log("");
if (failures === 0) {
  console.log("ALL PASS");
  process.exit(0);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}