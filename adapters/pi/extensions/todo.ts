import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { join } from "node:path";

// pi adapter for herdr-todo. Delegates /todo to the stable launcher created by
// the herdr-todo plugin's setup (~/.config/herdr/herdr-todo), which runs the
// same engine as the Herdr sidebar token + keybinding. Requires the herdr-todo
// Herdr plugin to be installed and set up once.

const SHIM = join(process.env.HOME ?? "", ".config", "herdr", "herdr-todo");

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
            "and creates a launcher. Proceed?",
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
    const p = spawn(SHIM, ["once"], { stdio: "ignore" });
    p.on("error", () => {});
    p.unref();
  } catch {}
}

function run(args: string[]) {
  return new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    const p = spawn(SHIM, args, {});
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", () => resolve({ stdout: "", stderr: "", code: 1 }));
    p.on("close", (c) => resolve({ stdout, stderr, code: c ?? 0 }));
  });
}