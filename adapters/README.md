# Agent adapters

The Herdr keybinding / sidebar token covers **every** agent — no adapter needed.
These adapters add a `/todo` slash command (or rule) inside a specific agent. All
of them call the same engine via `todo` on PATH (installed by setup into
`~/.local/bin/todo`), falling back to the stable launcher
`~/.config/herdr/herdr-todo`.

**Quick onboarding:** `~/.config/herdr/herdr-todo adapters install`
auto-installs the global adapters (pi, OpenCode, Grok) and prints where to put
the project-level ones (Cline). Use `adapters list` to see status.

| Agent | Adapter | Install |
|---|---|---|
| **pi** | `pi/` (pi package) | `pi install ./adapters/pi` → `/todo` |
| **OpenCode** | `opencode/todo.md` + `opencode/tui-pkg/` | copy to `~/.config/opencode/commands/todo.md`, then `opencode plugin ./opencode/tui-pkg --global` (adds `ctrl+x t` + palette) |
| **Grok** | `grok/SKILL.md` | copy to `~/.grok/skills/todo/SKILL.md` |
| **Cline** | `cline/todo.md` | copy to `.clinerules/todo.md` |

> Slash-command agents (pi, OpenCode) run the engine in one step. OpenCode
> additionally gets a `ctrl+x t` keybinding + command palette (installed as a
> package via `opencode plugin`). Grok and Cline are instructed via a skill /
> rules file to run `~/.config/herdr/herdr-todo …` when you ask.
>
> `todo open` (or `/todo open` / `<leader>t`) opens a **live** right-hand pane
> that lists todos and re-renders on every change to `TODOS.md` / `TODO.md`.

## Prerequisite

Run once (creates the launcher + wires Herdr):

```bash
herdr plugin action invoke herdr-todo.setup
```

Then install whichever adapter(s) you want.

## Updating

After the plugin source changes, refresh the adapters in one step:

```bash
~/.config/herdr/herdr-todo update        # pull + re-setup + reinstall adapters + reload plugin
# or, from any agent:
/todo update
```

`update` re-pulls the plugin checkout, rewires the launcher/config, restarts the
poller, reinstalls the global adapters (pi, OpenCode, Grok), and reloads the
Herdr plugin manifest. Cline's project-level `.clinerules/todo.md` is copied
per project.