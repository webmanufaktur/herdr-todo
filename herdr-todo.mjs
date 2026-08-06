#!/usr/bin/env node
// herdr-todo — Herdr plugin + engine for the todo engine (`todo`).
//
// As a Herdr plugin it mirrors herdr-changed:
//   - polls each workspace's TODOS.md/TODO.md and reports a `$todos_open` sidebar token
//   - when a workspace is active (any agent running — pi, opencode, cline,
//     grok, kilo, droid, … — or simply has panes open), opens a dedicated
//     TODO TAB for each present todo file (TODO.md and TODOS.md each get their
//     own tab); the tab stays open even when the todos hit 0
//   - `setup`/`teardown` wire the sidebar token + install a keep-alive poller
//   - `adapters` installs the per-agent /todo adapters
//     (pi/opencode/cline/grok/kilo/droid)
//
// The engine itself lives in todo.mjs (imported here for counting).

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, openTasks } from "./todo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "herdr");
const CONFIG = join(CONFIG_DIR, "config.toml");
const LAUNCHER = join(CONFIG_DIR, "herdr-todo");
const LOCAL_BIN = join(HOME, ".local", "bin");
const TODO_BIN = join(LOCAL_BIN, "todo");
const ENGINE = join(__dirname, "todo.mjs");
const STATE_FILE = join(CONFIG_DIR, "herdr-todo-state.json");
const SOURCE = "herdr-todo";
const PLUGIN_ID = "herdr-todo";

// Every present todo file is important — both TODO.md and TODOS.md get their
// own tab. Discovery returns ALL present files (never prefer one over the other).
const TODO_FILE_NAMES = ["TODOS.md", "TODO.md"];

// Engine subcommands (todo.mjs). "open" is shared: bare `open` → todo tab(s),
// `open <text>` → reopen a done task via the engine.
const ENGINE_CMDS = new Set(["list", "status", "add", "done", "next", "init", "count"]);

// Display title for the live todo list tab.
const TODO_PANE_TITLE = "todo";

// Auto-open toggle: when set, the poller opens a dedicated todo TAB (one per
// present todo file) for any active workspace — one with an agent running
// (**any** Herdr-detected kind: pi, opencode, cline, grok, kilo, droid, …) or
// simply with panes open (covers manual agent launches Herdr can't yet detect).
// The tab stays open even when the todos reach 0. Driven by Herdr's own
// workspace/agent registry, not by any one agent's extension.
const AUTO_OPEN = (process.env.HERDR_TODO_AUTO_OPEN ?? "1") !== "0";

// Poll health: while the Herdr server is unreachable we back off and log at
// most once per outage, so a long outage never spams the keep-alive log and
// the poller self-heals the moment the server returns (no per-agent
// self-heal needed — the keep-alive itself does the healing).
const INTERVAL_S = Number(process.env.HERDR_TODO_INTERVAL || 4);
const UNREACHABLE_BACKOFF_S = 30; // poll this often while the server is down
const UNREACHABLE_THRESHOLD = 3; // consecutive failures before backing off
let _unreachableStreak = 0;
const TTL_MS = Number(process.env.HERDR_TODO_TTL_MS || 12000);
const GIT_TIMEOUT_MS = 5000;

const TOKEN_OPEN = '    { token = "$todos_open",   fg = "#89b4fa", bold = true },';
const TOKEN_ANCHOR = '    "git_status" ],';

// ---- helpers ----------------------------------------------------------------

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

function run(cmd, opts = {}) {
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: "utf8",
    timeout: opts.timeout || 10000,
    ...opts,
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function workspaces() {
  const r = run([herdrBin(), "workspace", "list"]);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    return data?.result?.workspaces || [];
  } catch {
    return null;
  }
}

function paneCwds() {
  const r = run([herdrBin(), "pane", "list"]);
  if (r.code !== 0) return {};
  try {
    const data = JSON.parse(r.stdout);
    const panes = data?.result?.panes || [];
    const map = {};
    for (const p of panes) {
      const wid = p.workspace_id;
      const cwd = p.cwd || p.current_dir;
      if (wid && cwd && !map[wid]) map[wid] = cwd;
    }
    return map;
  } catch {
    return {};
  }
}

// Map of workspace_id -> [pane_id, ...] for every pane currently open.
function paneIdsByWorkspace() {
  const r = run([herdrBin(), "pane", "list"]);
  if (r.code !== 0) return {};
  try {
    const data = JSON.parse(r.stdout);
    const panes = data?.result?.panes || [];
    const map = {};
    for (const p of panes) {
      const wid = p.workspace_id;
      if (wid && p.pane_id) (map[wid] ||= []).push(p.pane_id);
    }
    return map;
  } catch {
    return {};
  }
}

// ---- todo-pane state (which pane we opened per workspace) ----------------------

function readState() {
  let state = {};
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) || {};
  } catch {
    state = {};
  }
  // Normalize legacy entry shape: workspace_id -> pane_id (scalar). That becomes
  // workspace_id -> {} (the per-file map). The per-file tabs re-open on next poll.
  for (const [wid, v] of Object.entries(state)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      state[wid] = {};
    }
  }
  return state;
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// Clean stale entries where the recorded pane no longer exists.
// State shape: workspace_id -> { basename(file) -> { tab_id, pane_id } }.
function pruneState(state, paneIdsByWs) {
  let changed = false;
  for (const [wid, entry] of Object.entries(state)) {
    const isMap =
      typeof entry === "object" && entry !== null && !Array.isArray(entry);
    if (!isMap) {
      // Legacy scalar pane_id → drop (tabs re-open on next poll via auto-open).
      delete state[wid];
      changed = true;
      continue;
    }
    for (const [key, rec] of Object.entries(entry)) {
      const pid =
        typeof rec === "object" && rec !== null ? (rec.pane_id ?? null) : rec;
      if (!pid || !(paneIdsByWs[wid] || []).includes(pid)) {
        delete entry[key];
        changed = true;
      }
    }
    if (!Object.keys(entry).length) {
      delete state[wid];
      changed = true;
    }
  }
  return changed;
}

function resolveToplevel(cwd) {
  const r = run(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeout: GIT_TIMEOUT_MS });
  return r.code === 0 ? r.stdout.trim() : null;
}

function gitDirFor(ws, cwdMap) {
  const wt = ws.worktree;
  if (wt?.checkout_path) return wt.checkout_path;
  if (wt?.repo_root) return wt.repo_root;
  const cwd = cwdMap[ws.workspace_id];
  if (cwd) return resolveToplevel(cwd);
  return null;
}

// Every present todo file in a repo root — both TODO.md and TODOS.md are
// important, so we return ALL of them (never drop one because the other exists).
function todoFilesFor(root) {
  if (!root || !existsSync(root)) return [];
  return TODO_FILE_NAMES.map((n) => join(root, n)).filter(existsSync);
}

// Open task count in one specific todo file.
function countOpenInFile(file) {
  const sections = parse(readFileSync(file, "utf8"));
  return openTasks(sections).length;
}

// Total open tasks across every present todo file (null when none exist).
function countOpenIn(root) {
  const files = todoFilesFor(root);
  if (!files.length) return null;
  return files.reduce((n, f) => n + countOpenInFile(f), 0);
}

// ---- token reporting --------------------------------------------------------

function report(wsId, openVal) {
  const val = openVal > 0 ? `${openVal} todos` : "";
  run([
    herdrBin(), "workspace", "report-metadata", wsId,
    "--source", SOURCE,
    "--token", `todos_open=${val}`,
    "--ttl-ms", String(TTL_MS),
    "--seq", String(Date.now()),
  ], { timeout: 5000 });
}

function clearTokens(wsId) {
  run([
    herdrBin(), "workspace", "report-metadata", wsId,
    "--source", SOURCE,
    "--clear-token", "todos_open",
  ], { timeout: 5000 });
}

// Which workspace agent_status values mean "an agent is present" (as opposed to
// "unknown" = no classified agent). Herdr reports these after recognizing an
// agent in a pane via its per-agent integration hooks or `agent start`.
const PRESENT_AGENT_STATUS = new Set(["idle", "working", "blocked", "done"]);

// Map workspace_id -> [agent, ...] from `herdr agent list` (Herdr's own registry
// of recognized agents). This is the authoritative, agent-agnostic source of
// "an agent is running here" — it covers pi, opencode, cline, grok, kilo,
// droid, …
function agentsByWorkspace() {
  const r = run([herdrBin(), "agent", "list"]);
  if (r.code !== 0) return {};
  try {
    const agents = JSON.parse(r.stdout)?.result?.agents || [];
    const map = {};
    for (const a of agents) {
      if (a.workspace_id) (map[a.workspace_id] ||= []).push(a);
    }
    return map;
  } catch {
    return {};
  }
}

// Does this workspace currently have an agent running? True when Herdr's agent
// registry lists one here, or the workspace's aggregated agent_status is a
// known present-state. "unknown" alone does NOT count (it is the no-agent
// marker and would otherwise re-open panes in empty workspaces).
function agentRunning(w, agentsByWs) {
  if ((agentsByWs[w.workspace_id] || []).length > 0) return true;
  return PRESENT_AGENT_STATUS.has(w.agent_status);
}

// ---- poll ---------------------------------------------------------------------

function poll(dryRun) {
  const ws = workspaces();
  if (!ws) {
    // Throttle: log only the transition in/out of an outage, never every tick.
    _unreachableStreak += 1;
    if (_unreachableStreak === 1) console.error("herdr server unreachable");
    return 1;
  }
  if (_unreachableStreak > 0) {
    _unreachableStreak = 0;
    if (!dryRun) console.error("herdr server reachable again");
  }
  const cwdMap = paneCwds();
  const paneIdsByWs = paneIdsByWorkspace();
  const agentsByWs = agentsByWorkspace();
  const state = readState();
  pruneState(state, paneIdsByWs);
  let n = 0;
  for (const w of ws) {
    const wid = w.workspace_id;
    const root = gitDirFor(w, cwdMap);
    const label = w.label || wid;
    if (!root || !existsSync(root)) {
      if (!dryRun) clearTokens(wid);
      continue;
    }
    const count = countOpenIn(root);
    if (count === null) {
      if (!dryRun) clearTokens(wid);
      continue;
    }
    const hasAgent = agentRunning(w, agentsByWs);
    // A workspace is "active" when an agent is running there OR it simply has
    // panes open — the latter covers agents Herdr can't (yet) detect (manual
    // launches of any agent), so the todo pane opens for them too.
    const active = hasAgent || (paneIdsByWs[wid] || []).length > 0;
    if (!dryRun) {
      report(wid, String(count));
      if (AUTO_OPEN) autoOpenTodoTabs(wid, root, active, state, paneIdsByWs);
    } else {
      console.log(`${wid}\t${label}\t${root}`);
      console.log(`         open=${count}  active=${active ? "yes" : "no"} (agent=${hasAgent ? "yes" : "no"})  ->  todos_open=${count > 0 ? count + " todos" : ""}`);
    }
    n += 1;
  }
  if (AUTO_OPEN) writeState(state);
  if (dryRun) console.log(`\n${n} workspace(s) with a TODOS.md/TODO.md. No metadata written.`);
  return 0;
}

// Drive the todo tabs from Herdr activity:
//   - open/keep one todo tab per present todo file (TODO.md / TODOS.md) when a
//     workspace is active (an agent is running there, or it simply has panes
//     open — manual launches of any agent count);
//   - the tab STAYS OPEN even when the project has 0 open todos (the todo file
//     is important, not just when non-empty);
//   - never open a tab for an inactive workspace (no panes at all), and don't
//     yank an already-open tab when the agent merely goes idle;
//   - close a tab only when its todo file has been deleted from the root.
//   `state` maps workspace_id -> { basename(file) -> { tab_id, pane_id } }
//   (persisted across polls).
function autoOpenTodoTabs(wid, root, active, state, paneIdsByWs) {
  if (!active) return; // inactive workspace: keep open but don't open new tabs
  const files = todoFilesFor(root);
  if (!files.length) return;
  const per = state[wid] || (state[wid] = {});
  const live = paneIdsByWs[wid] || [];
  for (const file of files) {
    const key = basename(file);
    let existing = per[key];
    if (existing && live.includes(existing.pane_id)) continue; // already showing
    // Fall back to matching by tab label so we never duplicate after state loss.
    existing = findTodoTab(wid, file);
    if (existing?.pane_id && live.includes(existing.pane_id)) {
      per[key] = existing;
      continue;
    }
    const opened = openTodoTab(wid, root, file);
    if (opened) per[key] = { tab_id: opened.tab_id, pane_id: opened.pane_id };
  }
  // Cleanup: close a tab whose todo file has been deleted from the root.
  for (const key of Object.keys(per)) {
    const stillExists = files.some((f) => basename(f) === key);
    if (!stillExists && per[key] && live.includes(per[key].pane_id)) {
      closeTodoTab(per[key]);
      delete per[key];
    }
  }
}

// ---- config.toml token wiring --------------------------------------------------

function readConfig() {
  return readFileSync(CONFIG, "utf8");
}

function sectionBounds(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    // TOML table headers start at column 0 (array elements are indented).
    if (/^\[[^\]]+\]\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, lines };
}

function ensureTodosTokens(text) {
  const sb = sectionBounds(text, "[ui.sidebar.spaces]");
  if (!sb) return { text, note: "skipped: no [ui.sidebar.spaces] section" };
  const { start, end, lines } = sb;
  if (lines.some((l) => l.includes("$todos_open"))) {
    return { text, note: "tokens already present" };
  }
  // Insert $todos_open into the branch row, right before the trailing git_status row.
  const insertAt = lines.findIndex((l, i) => i > start && i < end && l.trim() === TOKEN_ANCHOR);
  if (insertAt === -1) return { text, note: "could not find git_status row" };
  const newLines = lines.slice(0, insertAt).concat(TOKEN_OPEN, lines.slice(insertAt));
  return { text: newLines.join("\n"), note: "added todos_open token" };
}

function removeTodosTokens(text) {
  const lines = text.split("\n");
  const filtered = lines.filter((l) => !l.includes("$todos_open"));
  return { text: filtered.join("\n"), removed: lines.length - filtered.length };
}

// ---- launcher + PATH install ---------------------------------------------------

function chmodX(path) {
  try {
    const p = spawnSync("chmod", ["+x", path]);
    if (p.status !== 0) console.error("warning: could not chmod " + path);
  } catch {}
}

// Copy `src` → `dst` only when content differs (or dst is missing). Returns
// true when it actually wrote, false otherwise (unchanged, or a per-target
// failure like a dangling symlink — swallowed so one bad target never aborts
// the startup sync). Used by `cmdSync` so a quiet boot doesn't churn mtimes
// or relog on every Herdr start.
function copyIfChanged(src, dst) {
  try {
    let prev = "";
    try { prev = readFileSync(dst, "utf8"); } catch {}
    const next = readFileSync(src, "utf8");
    if (prev === next) return false;
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    return true;
  } catch {
    return false; // per-target failure: don't abort the sync
  }
}

function writeLauncher() {
  const shebang = `#!/usr/bin/env sh\n# Launcher managed by herdr-todo setup. Points at the plugin + engine proxy.\nexec node "${__dirname}/herdr-todo.mjs" "$@"\n`;
  writeFileSync(LAUNCHER, shebang, "utf8");
  chmodX(LAUNCHER);
}

// Install `todo` on the user PATH (~/.local/bin/todo → engine). Agents and
// shells can then run `todo list|add|done|…` without knowing the plugin root.
function installTodoOnPath() {
  mkdirSync(LOCAL_BIN, { recursive: true });
  const shebang = `#!/usr/bin/env sh\n# Launcher managed by herdr-todo setup. Points at the todo engine.\nexec node "${ENGINE}" "$@"\n`;
  writeFileSync(TODO_BIN, shebang, "utf8");
  chmodX(TODO_BIN);
  const pathEnv = process.env.PATH || "";
  const onPath = pathEnv.split(":").includes(LOCAL_BIN);
  return onPath
    ? `todo on PATH: ${TODO_BIN}`
    : `todo installed at ${TODO_BIN} (add ${LOCAL_BIN} to PATH so agents can run \`todo\`)`;
}

// Forward engine commands to todo.mjs (used by adapters that still call the
// herdr-todo launcher for list/add/done/…).
function runEngine(args) {
  const r = spawnSync(process.execPath, [ENGINE, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}

// ---- keep-alive (launchd on macOS, systemd on Linux) ----------------------------

function installKeepAlive() {
  const platform = process.platform;
  if (platform === "darwin") {
    const plistDir = join(HOME, "Library", "LaunchAgents");
    mkdirSync(plistDir, { recursive: true });
    const plist = join(plistDir, "dev.herdr.todo.plist");
    const envPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>dev.herdr.todo</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/env</string>
        <string>node</string>
        <string>${__dirname}/herdr-todo.mjs</string>
        <string>loop</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Background</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HERDR_BIN_PATH</key><string>${herdrBin()}</string>
        <key>HERDR_TODO_INTERVAL</key><string>${INTERVAL_S}</string>
        <key>HERDR_TODO_TTL_MS</key><string>${TTL_MS}</string>
        <key>PATH</key><string>${envPath}</string>
    </dict>
    <key>StandardOutPath</key><string>${join(CONFIG_DIR, "herdr-todo.log")}</string>
    <key>StandardErrorPath</key><string>${join(CONFIG_DIR, "herdr-todo.log")}</string>
</dict>
</plist>
`;
    writeFileSync(plist, xml, "utf8");
    run(["launchctl", "load", plist]);
    return `launchctl loaded ${plist}`;
  }
  if (platform === "linux") {
    const unitDir = join(HOME, ".config", "systemd", "user");
    mkdirSync(unitDir, { recursive: true });
    const unit = join(unitDir, "herdr-todo.service");
    const envPath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";
    const text = `[Unit]
Description=herdr-todo sidebar poller
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${__dirname}/herdr-todo.mjs loop
Environment=HERDR_BIN_PATH=${herdrBin()}
Environment=HERDR_TODO_INTERVAL=${INTERVAL_S}
Environment=HERDR_TODO_TTL_MS=${TTL_MS}
Environment=PATH=${envPath}
Restart=always

[Install]
WantedBy=default.target
`;
    writeFileSync(unit, text, "utf8");
    run(["systemctl", "--user", "daemon-reload"]);
    run(["systemctl", "--user", "enable", "--now", "herdr-todo.service"]);
    return `systemd enabled ${unit}`;
  }
  return `keep-alive: unsupported platform ${platform} (run 'loop' manually)`;
}

function restartKeepAlive() {
  stopKeepAlive();
  return installKeepAlive();
}

function stopKeepAlive() {
  const platform = process.platform;
  if (platform === "darwin") {
    const plist = join(HOME, "Library", "LaunchAgents", "dev.herdr.todo.plist");
    if (existsSync(plist)) {
      run(["launchctl", "unload", plist]);
      try { rmSync(plist, { force: true }); } catch {}
    }
    return "launchd stopped";
  }
  if (platform === "linux") {
    run(["systemctl", "--user", "disable", "--now", "herdr-todo.service"]);
    return "systemd stopped";
  }
  return "no keep-alive";
}

// ---- setup / teardown ----------------------------------------------------------

function cmdSetup() {
  // backup config
  if (existsSync(CONFIG) && !existsSync(CONFIG + ".bak")) {
    copyFileSync(CONFIG, CONFIG + ".bak");
  }
  let text = "";
  if (existsSync(CONFIG)) text = readConfig();
  const res = ensureTodosTokens(text);
  if (res.text !== text) writeFileSync(CONFIG, res.text, "utf8");
  writeLauncher();
  const pathNote = installTodoOnPath();
  const ka = installKeepAlive();
  // report once so sidebar populates immediately
  poll(false);
  return `setup done:\n  ${res.note}\n  launcher: ${LAUNCHER}\n  ${pathNote}\n  ${ka}`;
}

// Lightweight, idempotent restore run at Herdr startup ([[startup]] hook) and
// available as `herdr-todo sync`. Everything here is safe to re-run and tolerates
// a missing/offline/dirty state silently — a boot must never fail noisily. It is
// the cheap subset of `setup` + `adapters install`: no git pull, no package-
// manager installs, no `herdr integration install`. For a full refresh run
// `herdr-todo update`.
//
//   - restore sidebar tokens (no backup — setup took the one-time backup)
//   - rewrite the launcher + `todo` on PATH (idempotent)
//   - ensure the keep-alive poller is registered (idempotent; reload is a no-op
//     when already loaded, restarts it with the current engine otherwise)
//   - re-copy the shared + planning skill .md files (plain copies; skipped when
//     unchanged) so adapters track the installed plugin source
//   - poll once so the sidebar populates immediately
function cmdSync() {
  const out = [];
  const note = (s) => out.push(s);
  // Wrap each step so one failure doesn't abort the rest of the boot.
  const step = (label, fn) => {
    try { note(`${label}: ${fn()}`); }
    catch (e) { note(`${label}: skipped (${(e && e.message) || e})`); }
  };

  // 1. Sidebar tokens.
  step("tokens", () => {
    let text = existsSync(CONFIG) ? readConfig() : "";
    const res = ensureTodosTokens(text);
    if (res.text !== text) writeFileSync(CONFIG, res.text, "utf8");
    return res.note;
  });
  // 2. Launcher + todo on PATH.
  step("launcher", () => { writeLauncher(); return "ok"; });
  step("path", () => installTodoOnPath());
  // 3. Keep-alive: register/refresh (idempotent). installKeepAlive reloads the
  //    plist/unit; a reload is a no-op when already loaded.
  step("keep-alive", () => installKeepAlive());
  // 4. Re-copy skill files (the cheap part of `adapters install`). No package
  //    managers, no integration installs — those are explicit `update`. Each
  //    target is independent — a dangling symlink under one mirror (e.g. ~/.pi)
  //    is skipped, not fatal.
  step("skills", () => {
    const home = homedir();
    const root = adaptersRoot();
    let targets = 0, updated = 0;
    const put = (srcFile, dstFile) => {
      if (!existsSync(srcFile)) return;
      targets += 1;
      if (copyIfChanged(srcFile, dstFile)) updated += 1;
    };
    const src = join(root, "skill", "SKILL.md");
    put(src, join(home, ".agents", "skills", "todo", "SKILL.md"));
    put(src, join(home, ".grok", "skills", "todo", "SKILL.md"));
    const plan = join(root, "planning", "SKILL.md");
    put(plan, join(home, ".agents", "skills", "planning-todos", "SKILL.md"));
    put(plan, join(home, ".pi", "agent", "skills", "planning-todos", "SKILL.md"));
    return updated > 0 ? `${updated}/${targets} skill file(s) updated` : `current (${targets} targets)`;
  });
  // 5. Poll once so the sidebar reflects current state immediately.
  step("poll", () => { poll(false); return "ok"; });
  return `sync done:\n  ${out.join("\n  ")}`;
}

// Update the installed plugin: pull latest sources, rewire config/launcher,
// restart the poller, reinstall adapters, and reload the Herdr plugin manifest.
function cmdUpdate() {
  const out = [];
  const root = __dirname;
  const isGit = existsSync(join(root, ".git"));

  // 1. Pull latest sources (if the checkout is a git repo).
  if (isGit) {
    out.push("1. pulling latest sources (git pull)");
    const pull = run(["git", "-C", root, "pull", "--ff-only"], { timeout: 60000 });
    if (pull.code === 0) {
      out.push("   git pull: ok");
    } else {
      const err = (pull.stderr || pull.stdout).trim();
      out.push("   git pull: " + (err || "failed"));
      if (/unstaged changes|local changes|not clean/i.test(err)) {
        out.push("   hint: commit or stash local changes first, then re-run: herdr-todo update");
      }
    }
  } else {
    out.push("1. not a git checkout — skipping git pull (plugin root: " + root + ")");
  }

  // 2. Re-run setup: rewrite config.toml tokens, launcher, keep-alive, report.
  out.push("2. re-running setup (rewire config + launcher + poller)");
  const setupRes = cmdSetup();
  out.push(indentBlock(setupRes, "   "));

  // 3. Restart the poller so it runs the freshly pulled engine.
  out.push("3. restarting keep-alive poller");
  out.push("   " + restartKeepAlive());

  // 4. Reinstall per-agent adapters.
  out.push("4. reinstalling adapters");
  const adaptersRes = cmdAdapters(["install"]);
  out.push(indentBlock(adaptersRes, "   "));

  // 5. Reload the Herdr plugin manifest (re-link local plugin).
  out.push("5. reloading Herdr plugin manifest");
  const reload = reloadPlugin(root);
  out.push("   " + reload);

  // 6. Report once so the sidebar populates immediately.
  poll(false);
  out.push("6. polled once — sidebar now reflects current state");

  return out.join("\n");
}

function indentBlock(text, prefix) {
  return text.split("\n").map((l) => prefix + l).join("\n");
}

// Best-effort reload of the local plugin manifest by re-linking. Falls back to
// a no-op if the plugin isn't queryable.
function reloadPlugin(root) {
  const list = run([herdrBin(), "plugin", "list", "--plugin", PLUGIN_ID, "--json"], { timeout: 10000 });
  if (list.code !== 0) return "plugin not queryable (is it installed? run: herdr plugin link " + root + ")";
  // Re-link the local plugin so the manifest + actions are re-read.
  const unlink = run([herdrBin(), "plugin", "unlink", PLUGIN_ID], { timeout: 10000 });
  const link = run([herdrBin(), "plugin", "link", root], { timeout: 10000 });
  if (link.code !== 0) return "reload failed: " + (link.stderr.trim() || link.stdout.trim() || "could not re-link");
  return "manifest reloaded (unlink + link " + root + ")";
}

function cmdTeardown() {
  stopKeepAlive();
  if (existsSync(CONFIG)) {
    const res = removeTodosTokens(readConfig());
    if (res.removed > 0) writeFileSync(CONFIG, res.text, "utf8");
  }
  // clear reported tokens
  const ws = workspaces();
  if (ws) for (const w of ws) clearTokens(w.workspace_id);
  return `teardown done (removed ${res ? res.removed : 0} token line(s))`;
}

function cmdStatus() {
  const lines = [];
  lines.push(`engine: ${__dirname}`);
  lines.push(`launcher: ${LAUNCHER} (${existsSync(LAUNCHER) ? "present" : "MISSING"})`);
  lines.push(`todo bin: ${TODO_BIN} (${existsSync(TODO_BIN) ? "present" : "MISSING"})`);
  lines.push(`interval: ${INTERVAL_S}s   ttl: ${TTL_MS}ms`);
  const cfg = existsSync(CONFIG) ? readConfig() : "";
  lines.push(`config: tokens ${cfg.includes("$todos_open") ? "present" : "MISSING"} in [ui.sidebar.spaces]`);
  const ws = workspaces();
  if (ws) {
    const cwdMap = paneCwds();
    const paneIdsByWs = paneIdsByWorkspace();
    const agentsByWs = agentsByWorkspace();
    for (const w of ws) {
      const root = gitDirFor(w, cwdMap);
      const count = root ? countOpenIn(root) : null;
      const agent = agentRunning(w, agentsByWs) ? "agent" : "no agent";
      const active = (paneIdsByWs[w.workspace_id] || []).length > 0 ? "active" : "inactive";
      lines.push(`  ${w.label || w.workspace_id}: ${agent} | ${active} | ${count === null ? "no TODOS.md/TODO.md" : count + " open"}`);
    }
  }
  return lines.join("\n");
}

// Tab label for a todo file — used consistently for tab-name dedup.
function todoTabLabel(file) {
  return `todos · ${basename(file)}`;
}

// Look up an already-open todo tab for a given file by its label. Returns
// { tab_id, pane_id } (pane_id = any live pane on that tab) or null. Used so
// auto-open stays idempotent even if persisted state is stale or lost.
function findTodoTab(wsId, file) {
  const label = todoTabLabel(file);
  const t = run([
    herdrBin(), "tab", "list",
    ...(wsId ? ["--workspace", wsId] : []),
  ], { timeout: 8000 });
  if (t.code !== 0) return null;
  let tabId = null;
  try {
    tabId = JSON.parse(t.stdout)?.result?.tabs?.find((x) => x.label === label)?.tab_id || null;
  } catch {}
  if (!tabId) return null;
  const p = run([herdrBin(), "pane", "list"], { timeout: 8000 });
  try {
    const pane = JSON.parse(p.stdout)?.result?.panes?.find((x) => x.tab_id === tabId);
    if (pane) return { tab_id: tabId, pane_id: pane.pane_id };
  } catch {}
  return { tab_id: tabId, pane_id: null };
}

// Ensure a todo tab for a given file is open (dedup by live state, then by tab
// label for idempotency). Records { tab_id, pane_id } into `per`. Returns the
// existing or newly created { tab_id, pane_id } record (or zero if it was a
// label-matched tab with no live pane recorded yet).
function openTodoTabFor(wsId, dir, file, per) {
  const key = basename(file);
  const live = (paneIdsByWorkspace()[wsId] || []);
  let existing = per?.[key];
  if (existing && live.includes(existing.pane_id)) return existing;
  existing = findTodoTab(wsId, file);
  if (existing?.pane_id && live.includes(existing.pane_id)) {
    if (per) per[key] = existing;
    return existing;
  }
  const opened = openTodoTab(wsId, dir, file);
  if (opened && per) per[key] = opened;
  return opened;
}

// Open a dedicated todo TAB for one specific todo file.
// Returns { tab_id, pane_id } (the root pane running the live watcher) or null.
// The tab is display-only: `herdr agent start` on it refuses (display-agent).
// The rendered file is passed explicitly so TODO.md and TODOS.md each own a tab.
function openTodoTab(wsId, dir, file) {
  const created = run([
    herdrBin(), "tab", "create",
    ...(wsId ? ["--workspace", wsId] : []),
    "--cwd", dir,
    "--label", todoTabLabel(file),
    "--no-focus",
  ], { timeout: 10000 });
  if (created.code !== 0) return null;
  let tabId = null, rootPaneId = null;
  try {
    const data = JSON.parse(created.stdout)?.result || {};
    tabId = data?.tab?.tab_id || null;
    rootPaneId = data?.root_pane?.pane_id || null;
  } catch {}
  if (!tabId || !rootPaneId) return null;

  const watch = join(__dirname, "todo-watch.mjs");
  const paneRun = run([herdrBin(), "pane", "run", rootPaneId, `node ${watch} 4 --file ${file}`], { timeout: 5000 });
  if (paneRun.code !== 0) {
    run([herdrBin(), "tab", "close", tabId], { timeout: 5000 });
    return null;
  }
  markTodoTabDisplay(rootPaneId);
  return { tab_id: tabId, pane_id: rootPaneId };
}

// Mark the live list as a display surface so the UI (and agents) don't treat
// it as a free shell. `herdr agent start` on it still returns agent_pane_busy
// by design — the pane is running todo-watch, not an interactive shell.
function markTodoTabDisplay(paneId) {
  run([
    herdrBin(), "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--title", TODO_PANE_TITLE,
    "--display-agent", "todos",
    "--ttl-ms", String(TTL_MS * 10),
  ], { timeout: 3000 });
}

// Close the todo tab recorded for a file (rec = { tab_id, pane_id }), falling
// back to resolving the owning tab from the pane if no tab_id was stored.
function closeTodoTab(rec) {
  const pid = typeof rec === "object" && rec !== null ? rec.pane_id : rec;
  let tabId = typeof rec === "object" && rec !== null ? rec.tab_id : null;
  if (!tabId && pid) {
    const r = run([herdrBin(), "pane", "get", pid], { timeout: 5000 });
    try {
      tabId = JSON.parse(r.stdout)?.result?.pane?.tab_id || null;
    } catch {}
  }
  if (tabId) run([herdrBin(), "tab", "close", tabId], { timeout: 5000 });
  else if (pid) run([herdrBin(), "pane", "close", pid], { timeout: 5000 });
}

function cmdOpen(args) {
  // `open <text>` reopens a done task via the engine; bare `open` opens todo
  // tabs (one per present todo file). `open --file <path>` opens a tab
  // rendering that file (e.g. example.md).
  let fileTarget = null;
  if (args[0] === "--file") {
    fileTarget = args[1] || "";
    if (!fileTarget) return "usage: open [--file <path>] | open <text>";
    args = args.slice(2);
  }
  if (args.length > 0) {
    runEngine(["open", ...args]);
    return; // runEngine exits
  }

  // Find the current workspace's repo root (fallback: cwd).
  const ws = workspaces();
  const focused = ws?.find((w) => w.focused) || ws?.[0];
  const cwdMap = paneCwds();
  const root = focused ? gitDirFor(focused, cwdMap) : process.cwd();
  const dir = root || process.cwd();
  const wid = focused?.workspace_id;

  const state = readState();
  const per = wid ? (state[wid] ||= {}) : {};

  if (fileTarget) {
    const file = fileTarget.startsWith("/") ? fileTarget : join(dir, fileTarget);
    if (!existsSync(file)) return `no such file: ${file}`;
    const opened = openTodoTabFor(wid, dir, file, per);
    if (!opened?.pane_id) return `failed to open todo tab for ${basename(file)}`;
    if (wid) writeState(state);
    return `opened ${basename(file)} tab ${opened.pane_id} (live, refreshes every ${INTERVAL_S}s)`;
  }

  const files = todoFilesFor(dir);
  if (!files.length) return `no TODOS.md or TODO.md in ${dir} — run: todo init`;

  const openedIds = [];
  for (const file of files) {
    const opened = openTodoTabFor(wid, dir, file, per);
    if (opened?.pane_id) openedIds.push(`${basename(file)}:${opened.pane_id}`);
  }
  if (wid) writeState(state);
  if (!openedIds.length) return "failed to open todo tab(s)";
  return `opened ${openedIds.length} todo tab(s): ${openedIds.join(", ")} (live, refreshes every ${INTERVAL_S}s)`;
}

// `pane` — always opens the live todo tab(s) ("--file <path>" renders that file).
// Unlike bare `open <text>` (engine reopen) this never touches task state.
function cmdPane(args) {
  if (args.length > 0 && args[0] === "--file") {
    if (args.length !== 2 || !args[1]) return "usage: pane [--file <path>]";
    return cmdOpen(["--file", args[1]]);
  }
  if (args.length > 0) return "usage: pane [--file <path>]";
  return cmdOpen([]);
}

// ---- adapters ------------------------------------------------------------------

function adaptersRoot() {
  return join(__dirname, "adapters");
}

// Adapter table — each entry is one agent. Adding/removing an agent is a
// one-line change here; nothing else in this file is agent-specific.
//   name     — display label + directory under adapters/
//   dir      — source directory (existsSync check drives the "ok/missing" line)
//   install  — best-effort install step; pushes status lines to `out`
//   hint     — human hint shown by `adapters list` (where it lands / how)
// The todo engine + sidebar + live tabs already work for EVERY agent (they're
// driven by Herdr's own workspace/agent registry); these adapters only add a
// `/todo` surface inside a specific agent.
function adapterTable() {
  const root = adaptersRoot();
  const home = homedir();
  return [
    {
      name: "pi",
      dir: join(root, "pi"),
      hint: "pi install " + join(root, "pi") + "  →  /todo",
      install(out) {
        if (!existsSync(this.dir)) { out.push("pi: missing source dir"); return; }
        const r = run(["pi", "install", this.dir], { timeout: 30000 });
        out.push(`pi: ${r.code === 0 ? "installed" : "install failed (run manually: pi install " + this.dir + ")"}`);
      },
    },
    {
      name: "opencode",
      dir: join(root, "opencode"),
      hint: "~/.config/opencode/commands/todo.md + ctrl+x t (opencode plugin tui-pkg --global)",
      install(out) {
        const src = join(this.dir, "todo.md");
        if (!existsSync(src)) { out.push("opencode: missing source file"); return; }
        const dst = join(home, ".config", "opencode", "commands");
        mkdirSync(dst, { recursive: true });
        copyFileSync(src, join(dst, "todo.md"));
        out.push("opencode: slash command installed to ~/.config/opencode/commands/todo.md");
        const tui = join(this.dir, "tui-pkg");
        const r = run(["opencode", "plugin", tui, "--global"], { timeout: 30000 });
        out.push(`opencode: tui plugin ${r.code === 0 ? "installed" : "install failed (run: opencode plugin " + tui + " --global)"}`);
      },
    },
    {
      // The shared Agent Skills-standard skill. It is the single source for
      // every skill-loading agent — grok (mirrored to ~/.grok), kilo, pi, and
      // any other tool that reads ~/.agents/skills/.
      name: "todo skill (shared)",
      dir: join(root, "skill"),
      hint: "~/.agents/skills/todo/SKILL.md (cross-harness) + ~/.grok/skills/todo mirror",
      install(out) {
        const src = join(this.dir, "SKILL.md");
        if (!existsSync(src)) { out.push("todo skill: missing source file"); return; }
        // Canonical cross-harness location (Kilo, pi, any Agent-Skills tool).
        const agDir = join(home, ".agents", "skills", "todo");
        mkdirSync(agDir, { recursive: true });
        copyFileSync(src, join(agDir, "SKILL.md"));
        out.push("todo skill: installed to " + join(agDir, "SKILL.md") + " (covers kilo, pi, any Agent-Skills tool)");
        // grok-specific mirror (grok reads ~/.grok/skills/).
        const grokDir = join(home, ".grok", "skills", "todo");
        mkdirSync(grokDir, { recursive: true });
        copyFileSync(src, join(grokDir, "SKILL.md"));
        out.push("todo skill: mirrored for grok to " + join(grokDir, "SKILL.md"));
      },
    },
    {
      name: "planning-todos skill",
      dir: join(root, "planning"),
      hint: "~/.agents/skills/planning-todos/SKILL.md (+ ~/.pi/agent/skills mirror)",
      install(out) {
        const src = join(this.dir, "SKILL.md");
        if (!existsSync(src)) { out.push("planning-todos: missing source file"); return; }
        // Canonical cross-harness location.
        const agDir = join(home, ".agents", "skills", "planning-todos");
        mkdirSync(agDir, { recursive: true });
        const link = join(agDir, "SKILL.md");
        try { rmSync(link); } catch {}
        copyFileSync(src, link);
        out.push("planning-todos: installed to " + link);
        // pi mirror (pi loads ~/.pi/agent/skills).
        try {
          const piDir = join(home, ".pi", "agent", "skills", "planning-todos");
          mkdirSync(piDir, { recursive: true });
          copyFileSync(src, join(piDir, "SKILL.md"));
          out.push("planning-todos: mirrored for pi to " + join(piDir, "SKILL.md"));
        } catch {}
      },
    },
    {
      name: "cline",
      dir: join(root, "cline"),
      hint: "copy to .clinerules/todo.md (project-level)",
      install(out) {
        const src = join(this.dir, "todo.md");
        if (!existsSync(src)) { out.push("cline: missing source file"); return; }
        // Project-level: no global home to copy into. Point at the source.
        out.push("cline: copy " + src + " to .clinerules/todo.md (project-level)");
      },
    },
    {
      // droid reads AGENTS.md / ~/.factory/AGENTS.md, not ~/.agents/skills/.
      // It has no skill loader, so it drives todos purely via the `todo` engine
      // on PATH (installed by setup). Listed so `adapters list` is exhaustive.
      name: "droid",
      dir: null,
      hint: "no rules file — uses `todo` on PATH (installed by setup)",
      install(out) {
        out.push("droid: no skill/rules file (droid doesn't read ~/.agents/); uses `todo` on PATH");
      },
    },
  ];
}

function cmdAdapters(args) {
  const sub = args[0];
  const root = adaptersRoot();
  if (!existsSync(root)) return "no adapters/ directory in this checkout";
  const adapters = adapterTable();

  if (sub === "install") {
    const out = [];
    for (const a of adapters) a.install(out);

    // Herdr agent-detection integrations — let Herdr recognize these agents in
    // plain shells so the todo pane auto-opens for them too (the plugin reads
    // `herdr agent list`, which is populated by these hooks / `agent start`).
    // Best-effort: an unknown kind fails gracefully, and the poller's "panes
    // open" fallback keeps detection working regardless.
    for (const kind of ["pi", "opencode", "grok", "kilo", "droid"]) {
      const r = run([herdrBin(), "integration", "install", kind], { timeout: 30000 });
      out.push(`herdr: ${kind} detection ${r.code === 0 ? "integration installed/current" : "install failed (run manually: herdr integration install " + kind + ")"}`);
    }
    out.push("herdr: cline has no detection integration hook — start it with `herdr agent start --kind cline` so the todo pane auto-opens");
    return out.join("\n");
  }

  if (sub === "list") {
    const out = [];
    for (const a of adapters) {
      // A null dir (droid) is always "ok" — there's no source to ship.
      const present = a.dir ? existsSync(a.dir) : true;
      out.push(`${a.name}: ${present ? "ok" : "missing"}  ->  ${a.hint}`);
    }
    return out.join("\n");
  }

  return "usage: adapters install|list";
}

// ---- CLI -----------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);

function main() {
  // Bare invocation → engine list (what agents expect from `todo` / launcher).
  if (!cmd || ENGINE_CMDS.has(cmd)) {
    runEngine(cmd ? [cmd, ...rest] : ["list"]);
    return;
  }
  switch (cmd) {
    case "setup": console.log(cmdSetup()); break;
    case "sync": console.log(cmdSync()); break;
    case "update": console.log(cmdUpdate()); break;
    case "teardown": console.log(cmdTeardown()); break;
    // poller-status: plugin/poller health (engine `status` is open counts)
    case "poller-status":
    case "plugin-status":
      console.log(cmdStatus());
      break;
    case "once": console.log(poll(false)); break;
    case "loop": runLoop(); break;
    case "open": {
      const out = cmdOpen(rest);
      if (out != null) console.log(out);
      break;
    }
    case "pane": {
      const out = cmdPane(rest);
      if (out != null) console.log(out);
      break;
    }
    case "adapters": console.log(cmdAdapters(rest)); break;
    default: console.log(usage()); process.exit(cmd ? 2 : 0);
  }
}

function runLoop() {
  // Poll forever (keep-alive entry). While the server is unreachable we back
  // off to UNREACHABLE_BACKOFF_S; poll() resets the streak when it recovers,
  // so the interval snaps back to INTERVAL_S automatically.
  const schedule = () => {
    const delay =
      _unreachableStreak >= UNREACHABLE_THRESHOLD
        ? UNREACHABLE_BACKOFF_S * 1000
        : INTERVAL_S * 1000;
    setTimeout(() => {
      poll(false);
      schedule();
    }, delay);
  };
  poll(false);
  schedule();
}

function usage() {
  return `herdr-todo — Herdr plugin + todo engine proxy

Engine commands (also available as \`todo\` on PATH after setup):
  list [--all]   List open tasks
  status         Open counts per group
  add <body>     Add a task
  done <id|text> Mark done (moves to Done + stamps t:)
  open <text>    Reopen a done task
  next           Top-priority open task
  init           Create a TODOS.md in cwd
  count          Number of open tasks

Herdr plugin commands:
  setup          wire sidebar token + install keep-alive poller + PATH todo (backs up config)
  sync           idempotent restore run at Herdr startup ([[startup]] hook): tokens, launcher,
                 todo on PATH, keep-alive, skill files, one poll. No git pull / package installs.
  update         pull latest sources, re-setup, restart poller, reinstall adapters, reload plugin
  teardown       stop poller + remove token (reversible)
  poller-status  show poller state + per-workspace open counts
  once           poll once and report tokens
  loop           poll forever (keep-alive entry)
  open              open a live todo TAB per present todo file (TODO.md / TODOS.md)
  open --file        open a tab rendering the given file (e.g. example.md)
  pane              open the live todo tab(s) (alias for bare open); pane --file <path> renders that file

Adapter commands:
  adapters list|install    show/install per-agent /todo adapters
`;
}

main();