// herdr-todo-tui — OpenCode TUI plugin for Herdr todos.
//
// Gives OpenCode users a dedicated, instant todo command + command-palette
// entries — no need to type `/todo` or leave the prompt.
//
//   ctrl+x t                         list open todos (side pane)
//   ctrl+p  ->  "Herdr todo: …"   list / add / done / status / open pane
//
// (ctrl+x is OpenCode's default leader key, so "ctrl+x t" == "<leader>t".)
//
// OpenCode only loads TUI plugins from installed packages — a bare `.js` file
// in `plugins/` is treated as a server plugin. So this ships as a tiny package
// (package.json declares the `tui` export target) and is installed with:
//
//   opencode plugin <this-dir> --global
//
// Installed automatically by:  ~/.config/herdr/herdr-todo adapters install opencode
// Requires the launcher created by setup: ~/.config/herdr/herdr-todo
// (run `herdr plugin action invoke herdr-todo.setup` once).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LAUNCHER = join(homedir(), ".config", "herdr", "herdr-todo");

// Run the todo engine; returns { ok, text }.
function todo(arg) {
  if (!existsSync(LAUNCHER)) {
    return {
      ok: false,
      text: "herdr-todo not set up — run: herdr plugin action invoke herdr-todo.setup",
    };
  }
  try {
    const r = spawnSync(LAUNCHER, arg ? [arg] : ["list"], { encoding: "utf8", timeout: 15000 });
    const text = `${(r.stdout || "").trim()}${r.stderr ? "\n" + r.stderr.trim() : ""}`.trim();
    return { ok: r.status === 0, text: text || "done" };
  } catch (e) {
    return { ok: false, text: String((e && e.message) || e) };
  }
}

function toast(ui, r) {
  ui.toast({ variant: r.ok ? "success" : "error", message: r.text, duration: 4000 });
}

function cmd(api, name, title, desc, arg) {
  return {
    name,
    title,
    desc,
    category: "Herdr",
    namespace: "palette",
    run() {
      toast(api.ui, todo(arg));
    },
  };
}

const HerdrTodoTui = {
  id: "herdr-todo",
  tui: async (api) => {
    api.keymap.registerLayer({
      priority: 500,
      commands: [
        cmd(api, "herdr.todo.list", "Herdr todo: List", "List open todos", "list"),
        cmd(api, "herdr.todo.status", "Herdr todo: Status", "Show open counts per section", "status"),
        cmd(api, "herdr.todo.openpane", "Herdr todo: Open pane", "Open a live right-hand pane listing todos", "open"),
        cmd(api, "herdr.todo.next", "Herdr todo: Next", "Show top-priority open todo", "next"),
      ],
      bindings: [
        { key: "<leader>t", cmd: "herdr.todo.list", desc: "List open todos" },
      ],
    });
  },
};

// OpenCode resolves a plugin from `module.default` (an object with `tui`).
export { HerdrTodoTui };
export default HerdrTodoTui;