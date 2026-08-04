#!/usr/bin/env node
// herdr-todo — Herdr plugin + engine for the todo engine (`todo`).
//
// As a Herdr plugin it mirrors herdr-changed:
//   - polls each workspace's TODOS.md and reports a `$todos_open` sidebar token
//   - when an agent is running in a workspace (any Herdr-detected kind) with
//     open todos, opens a right-hand pane listing todos on the first tab
//     (plugin split); closes it when the todos hit 0
//   - `setup`/`teardown` wire the sidebar token + install a keep-alive poller
//   - `adapters` installs the per-agent /todo adapters (pi/opencode/cline/grok)
//
// The engine itself lives in todo.mjs (imported here for counting).

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findTodos, parse, openTasks } from "./todo.mjs";

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
const PANE_ENTRYPOINT = "todos";

// Engine subcommands (todo.mjs). "open" is shared: bare `open` → todo pane,
// `open <text>` → reopen a done task via the engine.
const ENGINE_CMDS = new Set(["list", "status", "add", "done", "next", "init", "count"]);

// Display title for the live todo list pane.
const TODO_PANE_TITLE = "todo";

// Auto-open toggle: when set, the poller opens a todo pane for any workspace
// that has an agent running (**any** Herdr-detected kind — pi, opencode, grok,
// cline, codex, …) and open todos, and closes it again when the todos reach 0.
// The pane is driven by Herdr's own agent registry, not by any one agent's
// extension, so it works regardless of which agent is running.
const AUTO_OPEN = (process.env.HERDR_TODO_AUTO_OPEN ?? "1") !== "0";

// Poll health: while the Herdr server is unreachable we back off and log at
// most once per outage, so a long outage never spams the keep-alive log and
// the poller self-heals the moment the server returns (no pi self-heal needed).
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
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) || {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// Clean stale entries where the recorded pane no longer exists.
function pruneState(state, paneIdsByWs) {
  let changed = false;
  for (const [wid, pid] of Object.entries(state)) {
    if (!(paneIdsByWs[wid] || []).includes(pid)) {
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

function todosFileFor(root) {
  if (!root || !existsSync(root)) return null;
  return findTodos(root);
}

function countOpenIn(root) {
  const file = todosFileFor(root);
  if (!file) return null;
  const sections = parse(readFileSync(file, "utf8"));
  return openTasks(sections).length;
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
// "an agent is running here" — it covers pi, opencode, grok, cline, codex, …
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
    if (!dryRun) {
      report(wid, String(count));
      if (AUTO_OPEN) autoOpenTodoPane(wid, root, count, hasAgent, state, paneIdsByWs);
    } else {
      console.log(`${wid}\t${label}\t${root}`);
      console.log(`         open=${count}  agent=${hasAgent ? "yes" : "no"}  ->  todos_open=${count > 0 ? count + " todos" : ""}`);
    }
    n += 1;
  }
  if (AUTO_OPEN) writeState(state);
  if (dryRun) console.log(`\n${n} workspace(s) with a TODOS.md/TODO.md. No metadata written.`);
  return 0;
}

// Drive the todo pane from Herdr's agent lifecycle + open todos:
//   - open/keep it when an agent is running AND there are open todos;
//   - close it when the todos reach 0 (regardless of agent);
//   - never open one for a workspace with no agent running, and don't yank an
//     already-open pane purely because the agent went idle (it stays until the
//     work is done). `state` maps workspace_id -> pane_id (persisted across polls).
function autoOpenTodoPane(wid, root, count, hasAgent, state, paneIdsByWs) {
  const existing = state[wid];
  if (!existing && !hasAgent) return; // no agent + no pane => nothing to do
  if (count === 0 && existing) {
    // No open todos left — close the pane we opened for this workspace.
    closeTodoPane(existing);
    delete state[wid];
    return;
  }
  if (!hasAgent) return; // agent gone, todos remain: keep, don't open new
  if (count > 0 && existing && (paneIdsByWs[wid] || []).includes(existing)) return;
  const pid = openTodoPane(wid, root);
  if (pid) state[wid] = pid;
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
    const agentsByWs = agentsByWorkspace();
    for (const w of ws) {
      const root = gitDirFor(w, cwdMap);
      const count = root ? countOpenIn(root) : null;
      const agent = agentRunning(w, agentsByWs) ? "agent" : "no agent";
      lines.push(`  ${w.label || w.workspace_id}: ${agent} | ${count === null ? "no TODOS.md/TODO.md" : count + " open"}`);
    }
  }
  return lines.join("\n");
}

// Pick a shell pane on the workspace's first tab to split from.
// Prefers non-owned panes so we don't nest inside an existing todo pane.
function firstTabSplitTarget(wsId, ownedPaneId) {
  const tabs = (() => {
    const args = [herdrBin(), "tab", "list"];
    if (wsId) args.push("--workspace", wsId);
    const r = run(args);
    if (r.code !== 0) return [];
    try {
      return JSON.parse(r.stdout)?.result?.tabs || [];
    } catch {
      return [];
    }
  })();
  // First tab = lowest number, fallback first entry.
  const sorted = [...tabs].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  const firstTabId = sorted[0]?.tab_id || null;

  const r = run([herdrBin(), "pane", "list"]);
  if (r.code !== 0) return null;
  let panes = [];
  try {
    panes = JSON.parse(r.stdout)?.result?.panes || [];
  } catch {
    return null;
  }
  const inWs = panes.filter((p) => p.workspace_id === wsId);
  const onFirst = firstTabId
    ? inWs.filter((p) => p.tab_id === firstTabId)
    : inWs;
  const pool = onFirst.length ? onFirst : inWs;
  const hit =
    pool.find((p) => p.pane_id !== ownedPaneId && p.label !== TODO_PANE_TITLE) ||
    pool.find((p) => p.pane_id !== ownedPaneId) ||
    pool[0];
  return hit?.pane_id || null;
}

// Open a plugin-owned todo pane (Herdr-managed split on the first tab).
// Returns pane id or null. Keeps the pane out of the agent-start pool.
// With `file` (absolute), the pane renders that file instead of the
// workspace's TODOS.md/TODO.md (passed to the watch script via $TODOS_FILE).
function openTodoPane(wsId, dir, file) {
  const state = readState();
  const owned = state[wsId];
  // Already have a live owned pane? (Skip the dedup when rendering a specific
  // file — that pane shows the project's TODOS.md, not the requested file.)
  if (owned && !file) {
    const ids = paneIdsByWorkspace()[wsId] || [];
    if (ids.includes(owned)) {
      run([herdrBin(), "plugin", "pane", "focus", owned], { timeout: 3000 });
      return owned;
    }
  }

  const target = firstTabSplitTarget(wsId, owned);
  if (!target) return null;

  const args = [
    herdrBin(), "plugin", "pane", "open",
    "--plugin", PLUGIN_ID,
    "--entrypoint", PANE_ENTRYPOINT,
    "--placement", "split",
    "--direction", "right",
    "--target-pane", target,
    "--cwd", dir,
    "--no-focus",
  ];
  if (file) args.push("--env", `TODOS_FILE=${file}`);
  if (wsId) args.push("--workspace", wsId);
  const opened = run(args, { timeout: 10000 });
  if (opened.code !== 0) {
    return openTodoPaneFallback(target, dir, file);
  }
  let paneId = null;
  try {
    const data = JSON.parse(opened.stdout);
    const pane = data?.result?.plugin_pane?.pane || data?.result?.pane || data?.result;
    paneId = pane?.pane_id || data?.result?.pane_id || null;
  } catch {
    paneId = null;
  }
  if (paneId) markTodoPaneDisplay(paneId);
  return paneId;
}

// Mark the live list as a display surface so the UI (and agents) don't treat
// it as a free shell. `herdr agent start` on it still returns agent_pane_busy
// by design — the pane is running todo-watch, not an interactive shell.
function markTodoPaneDisplay(paneId) {
  run([
    herdrBin(), "pane", "report-metadata", paneId,
    "--source", SOURCE,
    "--title", TODO_PANE_TITLE,
    "--display-agent", "todos",
    "--ttl-ms", String(TTL_MS * 10),
  ], { timeout: 3000 });
}

// Legacy path: split a shell pane and run todo-watch inside it.
function openTodoPaneFallback(target, dir, file) {
  const split = run([
    herdrBin(), "pane", "split", target, "--direction", "right",
    "--cwd", dir, "--no-focus",
  ]);
  if (split.code !== 0) return null;
  let paneId = null;
  try {
    paneId = JSON.parse(split.stdout)?.result?.pane?.pane_id;
  } catch {}
  if (!paneId) return null;
  const watch = join(__dirname, "todo-watch.mjs");
  const args = [herdrBin(), "pane", "run", paneId, "node", watch, "4"];
  if (file) args.push("--file", file);
  const paneRun = run(args, { timeout: 5000 });
  if (paneRun.code !== 0) return null;
  markTodoPaneDisplay(paneId);
  return paneId;
}

function closeTodoPane(paneId) {
  const plug = run([herdrBin(), "plugin", "pane", "close", paneId], { timeout: 5000 });
  if (plug.code === 0) return;
  run([herdrBin(), "pane", "close", paneId], { timeout: 5000 });
}

function cmdOpen(args) {
  // `open <text>` reopens a done task via the engine; bare `open` opens the pane.
  // `open --file <path>` opens the pane rendering that file (e.g. example.md).
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

  let file = null;
  if (fileTarget) {
    file = fileTarget.startsWith("/") ? fileTarget : join(dir, fileTarget);
    if (!existsSync(file)) return `no such file: ${file}`;
  } else if (!todosFileFor(dir)) {
    return `no TODOS.md or TODO.md in ${dir} — run: todo init`;
  }

  const paneId = openTodoPane(focused?.workspace_id, dir, file);
  if (!paneId) return "failed to open todo pane";
  // Remember it so auto-open does not duplicate, and auto-close can find it.
  if (focused?.workspace_id) {
    const state = readState();
    state[focused.workspace_id] = paneId;
    writeState(state);
  }
  const label = file ? basename(file) : "todo list";
  return `opened ${label} pane ${paneId} (live split on first tab, refreshes every 4s)`;
}

// `pane` — always opens the live todo pane ("--file <path>" renders that file).
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

function cmdAdapters(args) {
  const sub = args[0];
  const root = adaptersRoot();
  if (!existsSync(root)) return "no adapters/ directory in this checkout";
  const out = [];

  if (sub === "install") {
    // pi — install the pi package (best-effort).
    const piDir = join(root, "pi");
    if (existsSync(piDir)) {
      const r = run(["pi", "install", piDir], { timeout: 30000 });
      out.push(`pi: ${r.code === 0 ? "installed" : "install failed (run manually: pi install " + piDir + ")"}`);
    }
    // opencode — copy slash command + install tui package.
    const ocDir = join(homedir(), ".config", "opencode", "commands");
    mkdirSync(ocDir, { recursive: true });
    const ocSrc = join(root, "opencode", "todo.md");
    if (existsSync(ocSrc)) {
      copyFileSync(ocSrc, join(ocDir, "todo.md"));
      out.push("opencode: slash command installed to ~/.config/opencode/commands/todo.md");
      const tui = join(root, "opencode", "tui-pkg");
      const r = run(["opencode", "plugin", tui, "--global"], { timeout: 30000 });
      out.push(`opencode: tui plugin ${r.code === 0 ? "installed" : "install failed (run: opencode plugin " + tui + " --global)"}`);
    }
    // grok — copy skill.
    const grokDir = join(homedir(), ".grok", "skills", "todo");
    mkdirSync(grokDir, { recursive: true });
    const grokSrc = join(root, "grok", "SKILL.md");
    if (existsSync(grokSrc)) {
      copyFileSync(grokSrc, join(grokDir, "SKILL.md"));
      out.push("grok: skill installed to ~/.grok/skills/todo/SKILL.md");
    }
    // planning-todos — global pi skill (copy + optional cross-harness symlink).
    const planSrc = join(root, "planning", "SKILL.md");
    if (existsSync(planSrc)) {
      const planDir = join(homedir(), ".pi", "agent", "skills", "planning-todos");
      mkdirSync(planDir, { recursive: true });
      copyFileSync(planSrc, join(planDir, "SKILL.md"));
      out.push("planning-todos: pi skill installed to " + join(planDir, "SKILL.md"));
      // Cross-harness discovery (pi loads ~/.agents/skills too; cheap mirror).
      try {
        const altDir = join(homedir(), ".agents", "skills", "planning-todos");
        mkdirSync(altDir, { recursive: true });
        const link = join(altDir, "SKILL.md");
        try { rmSync(link); } catch {}
        copyFileSync(planSrc, link);
        out.push("planning-todos: mirrored to " + link);
      } catch {}
    }
    // Herdr agent-detection integrations — let Herdr recognize these agents in
    // plain shells so the todo pane auto-opens for them too (the plugin reads
    // `herdr agent list`, which is populated by these hooks / `agent start`).
    for (const kind of ["pi", "opencode", "grok"]) {
      const r = run([herdrBin(), "integration", "install", kind], { timeout: 30000 });
      out.push(`herdr: ${kind} detection ${r.code === 0 ? "integration installed/current" : "install failed (run manually: herdr integration install " + kind + ")"}`);
    }
    out.push("herdr: cline has no detection integration hook — start it with `herdr agent start --kind cline` so the todo pane auto-opens");
    // cline — project-level rule (point to it).
    out.push("cline: copy " + join(root, "cline", "todo.md") + " to .clinerules/todo.md (project-level)");
    return out.join("\n");
  }

  if (sub === "list") {
    const entries = [
      { name: "pi", dir: "pi", install: "pi install " + join(root, "pi") },
      { name: "opencode", dir: "opencode", install: "copy " + join(root, "opencode/todo.md") + " to ~/.config/opencode/commands/todo.md, then opencode plugin " + join(root, "opencode/tui-pkg") + " --global" },
      { name: "grok", dir: "grok", install: "copy " + join(root, "grok/SKILL.md") + " to ~/.grok/skills/todo/SKILL.md" },
      { name: "planning-todos", dir: "planning", install: "copy " + join(root, "planning/SKILL.md") + " to ~/.pi/agent/skills/planning-todos/SKILL.md (+ ~/.agents/skills/planning-todos)" },
      { name: "cline", dir: "cline", install: "copy " + join(root, "cline/todo.md") + " to .clinerules/todo.md (project-level)" },
    ];
    for (const e of entries) {
      const present = existsSync(join(root, e.dir));
      out.push(`${e.name}: ${present ? "ok" : "missing"}  ->  ${e.install}`);
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
  update         pull latest sources, re-setup, restart poller, reinstall adapters, reload plugin
  teardown       stop poller + remove token (reversible)
  poller-status  show poller state + per-workspace open counts
  once           poll once and report tokens
  loop           poll forever (keep-alive entry)
  open           open a live right-hand pane listing todos (first tab)
  open --file    same, but render the given file (e.g. example.md) instead of TODOS.md
  pane           open the live todo pane (alias for bare open); pane --file <path> renders that file

Adapter commands:
  adapters list|install    show/install per-agent /todo adapters
`;
}

main();