import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";

// pi adapter for herdr-todo. Prefers `todo` on PATH (installed by setup into
// ~/.local/bin/todo) for engine commands; falls back to the stable launcher
// (~/.config/herdr/herdr-todo) for plugin commands (setup/once/open pane/…).

const HOME = process.env.HOME ?? "";
const PLUGIN_LAUNCHER = join(HOME, ".config", "herdr", "herdr-todo");
const LOCAL_TODO = join(HOME, ".local", "bin", "todo");

// Plugin-only subcommands must go through the herdr-todo launcher.
const PLUGIN_CMDS = new Set([
  "setup",
  "update",
  "teardown",
  "once",
  "loop",
  "adapters",
  "poller-status",
  "plugin-status",
]);

function executable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveBin(args: string[]): string {
  const sub = args[0] ?? "list";
  // Bare `open` opens the plugin pane; `open <text>` reopens via the engine.
  const needsPlugin =
    PLUGIN_CMDS.has(sub) || (sub === "open" && args.length === 1);

  if (needsPlugin) {
    return executable(PLUGIN_LAUNCHER) ? PLUGIN_LAUNCHER : PLUGIN_LAUNCHER;
  }

  if (executable(LOCAL_TODO)) return LOCAL_TODO;
  if (executable(PLUGIN_LAUNCHER)) return PLUGIN_LAUNCHER;
  return "todo"; // last resort: PATH
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("todo", {
    description:
      "Portable TODOS.md engine + Herdr sidebar. /todo [list|status|add <body>|done <text>|" +
      "open <text>|next|init|open] -> opens a live right-hand pane listing todos",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts[0];

      if (sub === "setup") {
        const ok = await ctx.ui.confirm(
          "Herdr sidebar todos — setup",
          "Backs up ~/.config/herdr/config.toml, patches sidebar rows, installs a keep-alive, " +
            "installs `todo` on PATH, and creates a launcher. Proceed?",
        );
        if (!ok) {
          ctx.ui.notify("todo: setup cancelled", "info");
          return;
        }
      }

      const res = await run(parts);
      const hint =
        res.code !== 0 && !res.stdout && !res.stderr
          ? "(is herdr-todo set up? run: ~/.config/herdr/herdr-todo setup)"
          : "";
      const msg = (res.stdout || res.stderr || hint || "done").trim();
      ctx.ui.notify(`todo: ${msg}`, res.code === 0 ? "info" : "error");
    },
  });

  // Self-heal after a Herdr restart: re-report the todos_open token so the
  // sidebar count repopulates. Best-effort; never block pi startup.
  try {
    const p = spawn(PLUGIN_LAUNCHER, ["once"], { stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

function run(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const bin = resolveBin(args);
    const p = spawn(bin, args, {});
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", () => {
      // Retry via plugin launcher if PATH `todo` was missing.
      if (bin !== PLUGIN_LAUNCHER) {
        const p2 = spawn(PLUGIN_LAUNCHER, args, {});
        let out2 = "";
        let err2 = "";
        p2.stdout.on("data", (d) => (out2 += d.toString()));
        p2.stderr.on("data", (d) => (err2 += d.toString()));
        p2.on("error", () => resolve({ stdout: "", stderr: "", code: 1 }));
        p2.on("close", (c) => resolve({ stdout: out2, stderr: err2, code: c ?? 0 }));
      } else {
        resolve({ stdout: "", stderr: "", code: 1 });
      }
    });
    p.on("close", (c) => resolve({ stdout, stderr, code: c ?? 0 }));
  });
}
