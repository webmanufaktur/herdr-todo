#!/usr/bin/env node
// herdr-todo — Herdr plugin + engine for the todo engine (`todo`).
//
// As a Herdr plugin it mirrors herdr-changed:
//   - polls each workspace's TODOS.md and reports a `$todos_open` sidebar token
//   - `open` opens a right-hand pane listing todos (plugin pane / split)
//   - `setup`/`teardown` wire the sidebar token + install a keep-alive poller
//   - `adapters` installs the per-agent /todo adapters (pi/opencode/cline/grok)
//
// The engine itself lives in todo.mjs (imported here for counting).

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, symlinkSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findTodos, parse, openTasks, DEFAULT_SECTION } from "./todo.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "herdr");
const CONFIG = join(CONFIG_DIR, "config.toml");
const LAUNCHER = join(CONFIG_DIR, "herdr-todo");
const SOURCE = "herdr-todo";
const PLUGIN_ID = "herdr-todo";

const INTERVAL_S = Number(process.env.HERDR_TODO_INTERVAL || 4);
const TTL_MS = Number(process.env.HERDR_TODO_TTL_MS || 12000);
const GIT_TIMEOUT_MS = 5000;

const TOKEN_OPEN = '{ token = "$todos_open",  fg = "#89b4fa", bold = true },';
const TOKEN_ROW = `  [ ${TOKEN_OPEN} ],`;

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
  run([
    herdrBin(), "workspace", "report-metadata", wsId,
    "--source", SOURCE,
    "--token", `todos_open=${openVal}`,
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

// ---- poll ---------------------------------------------------------------------

function poll(dryRun) {
  const ws = workspaces();
  if (!ws) {
    console.error("herdr server unreachable");
    return 1;
  }
  const cwdMap = paneCwds();
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
    if (!dryRun) {
      report(wid, String(count));
    } else {
      console.log(`${wid}\t${label}\t${root}`);
      console.log(`         open=${count}  ->  todos_open=${count}`);
    }
    n += 1;
  }
  if (dryRun) console.log(`\n${n} workspace(s) with a TODOS.md. No metadata written.`);
  return 0;
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
  // Find the last row-entry line (ends with `],`) inside the `rows = [...]` array,
  // then insert the new row right after it (before the closing `]`).
  const block = lines.slice(start, end);
  let insertAt = -1;
  for (let i = block.length - 1; i >= 0; i--) {
    if (block[i].trim().endsWith("],")) {
      insertAt = start + i + 1;
      break;
    }
  }
  if (insertAt === -1) return { text, note: "could not find rows array" };
  const newLines = lines.slice(0, insertAt).concat(TOKEN_ROW, lines.slice(insertAt));
  return { text: newLines.join("\n"), note: "added todos_open row" };
}

function removeTodosTokens(text) {
  const lines = text.split("\n");
  const filtered = lines.filter((l) => !l.includes("$todos_open"));
  return { text: filtered.join("\n"), removed: lines.length - filtered.length };
}

// ---- launcher ----------------------------------------------------------------

function writeLauncher() {
  const shebang = `#!/usr/bin/env sh\n# Launcher managed by herdr-todo setup. Points at the installed engine.\nexec node "${__dirname}/herdr-todo.mjs" "$@"\n`;
  writeFileSync(LAUNCHER, shebang, "utf8");
  try {
    const p = spawnSync("chmod", ["+x", LAUNCHER]);
    if (p.status !== 0) console.error("warning: could not chmod launcher");
  } catch {}
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
  const ka = installKeepAlive();
  // report once so sidebar populates immediately
  poll(false);
  return `setup done:\n  ${res.note}\n  launcher: ${LAUNCHER}\n  ${ka}`;
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
  lines.push(`interval: ${INTERVAL_S}s   ttl: ${TTL_MS}ms`);
  const cfg = existsSync(CONFIG) ? readConfig() : "";
  lines.push(`config: tokens ${cfg.includes("$todos_open") ? "present" : "MISSING"} in [ui.sidebar.spaces]`);
  const ws = workspaces();
  if (ws) {
    const cwdMap = paneCwds();
    for (const w of ws) {
      const root = gitDirFor(w, cwdMap);
      const count = root ? countOpenIn(root) : null;
      lines.push(`  ${w.label || w.workspace_id}: ${count === null ? "no TODOS.md" : count + " open"}`);
    }
  }
  return lines.join("\n");
}

function cmdOpen(args) {
  // Find the current workspace's repo root (fallback: cwd).
  const ws = workspaces();
  const focused = ws?.find((w) => w.focused) || ws?.[0];
  const cwdMap = paneCwds();
  const root = focused ? gitDirFor(focused, cwdMap) : process.cwd();
  const dir = root || process.cwd();

  // Check there's a TODOS.md to show.
  if (!todosFileFor(dir)) {
    return `no TODOS.md in ${dir} — run: todo init`;
  }

  // Split a right-hand pane in the current pane and list todos there.
  const split = run([herdrBin(), "pane", "split", "--current", "--direction", "right", "--cwd", dir, "--no-focus"]);
  if (split.code !== 0) return split.stderr || "failed to split pane";
  let paneId = null;
  try {
    paneId = JSON.parse(split.stdout)?.result?.pane?.pane_id;
  } catch {}
  if (!paneId) return split.stdout || "opened pane (could not read id)";
  const engine = join(__dirname, "todo.mjs");
  const paneRun = run([herdrBin(), "pane", "run", paneId, "node", engine, "list"]);
  return paneRun.code === 0
    ? `opened todo pane ${paneId}`
    : (paneRun.stderr || `opened pane ${paneId} but could not run todo list`);
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
    // cline — project-level rule (point to it).
    out.push("cline: copy " + join(root, "cline", "todo.md") + " to .clinerules/todo.md (project-level)");
    return out.join("\n");
  }

  if (sub === "list") {
    const entries = [
      { name: "pi", dir: "pi", install: "pi install " + join(root, "pi") },
      { name: "opencode", dir: "opencode", install: "copy " + join(root, "opencode/todo.md") + " to ~/.config/opencode/commands/todo.md, then opencode plugin " + join(root, "opencode/tui-pkg") + " --global" },
      { name: "grok", dir: "grok", install: "copy " + join(root, "grok/SKILL.md") + " to ~/.grok/skills/todo/SKILL.md" },
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
  switch (cmd) {
    case "setup": console.log(cmdSetup()); break;
    case "teardown": console.log(cmdTeardown()); break;
    case "status": console.log(cmdStatus()); break;
    case "once": console.log(poll(false)); break;
    case "loop": runLoop(); break;
    case "open": console.log(cmdOpen(rest)); break;
    case "adapters": console.log(cmdAdapters(rest)); break;
    default: console.log(usage()); process.exit(cmd ? 2 : 0);
  }
}

function runLoop() {
  // Poll on an interval forever (for the keep-alive).
  const tick = () => poll(false);
  tick();
  setInterval(tick, INTERVAL_S * 1000);
}

function usage() {
  return `herdr-todo — Herdr plugin + todo engine

Herdr plugin commands:
  setup          wire sidebar token + install keep-alive poller (backs up config)
  teardown       stop poller + remove token (reversible)
  status         show poller state + per-workspace open counts
  once           poll once and report tokens
  loop           poll forever (keep-alive entry)
  open           open a right-hand pane listing todos

Adapter commands:
  adapters list|install    show/install per-agent /todo adapters
`;
}

main();