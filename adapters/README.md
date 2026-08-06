# Agent adapters

The Herdr keybinding / sidebar token covers **every** agent — no adapter needed.
The **todo tab auto-opens for any active workspace** with open todos (an agent
running there — pi, opencode, cline, grok, kilo, droid, … — or simply panes
open, so manual agent launches count too), driven by Herdr's own registry, not
by any one agent's adapter. These adapters add a `/todo` surface (slash command,
skill, or rule) inside a specific agent. All of them call the same engine via
`todo` on PATH (installed by setup into `~/.local/bin/todo`), falling back to the
stable launcher `~/.config/herdr/herdr-todo`.

**Quick onboarding:** `~/.config/herdr/herdr-todo adapters install`
auto-installs the global adapters — the shared **todo** Agent Skill (covers
Grok, Kilo, and any Agent-Skills-compliant tool), the **planning-todos** skill,
plus the pi package and the OpenCode slash command + `ctrl+x t` — and prints
where to put the project-level one (Cline). Use `adapters list` to see status.

| Agent | Adapter | Install |
|---|---|---|
| **pi** | `pi/` (pi package) | `pi install ./adapters/pi` → `/todo` |
| **OpenCode** | `opencode/todo.md` + `opencode/tui-pkg/` | copy to `~/.config/opencode/commands/todo.md`, then `opencode plugin ./opencode/tui-pkg --global` (adds `ctrl+x t` + palette) |
| **Grok** | `skill/SKILL.md` (shared skill) | installed to `~/.grok/skills/todo/SKILL.md` by `adapters install` |
| **Kilo** | `skill/SKILL.md` (shared skill) | installed to `~/.agents/skills/todo/SKILL.md` (Agent Skills standard) by `adapters install`; Kilo reads this dir |
| **Droid** | none (no skill loader) | uses `todo` on PATH directly; document it in your `AGENTS.md` if you like |
| **Cline** | `cline/todo.md` | copy to `.clinerules/todo.md` (project-level) |
| **planning-todos** (shared skill) | `planning/SKILL.md` | installed to `~/.agents/skills/planning-todos/SKILL.md` (+ `~/.pi/agent/skills/` mirror) — plans in `.plans/`, todos via the engine, agents in new tabs |

> Slash-command agents (pi, OpenCode) run the engine in one step. OpenCode
> additionally gets a `ctrl+x t` keybinding + command palette (installed as a
> package via `opencode plugin`). Skill-loading agents (Grok, Kilo) are
> instructed via the shared Agent Skills skill to run
> `~/.config/herdr/herdr-todo …` when you ask. Cline is instructed via a
> project rules file. Droid has no skill loader — it just runs `todo` on PATH.
>
> `todo pane` (or `/todo pane` / `<leader>t`) opens a **live** dedicated todo
> tab per present todo file (TODO.md / TODOS.md each get their own) that lists
> todos and re-renders on every change to `TODOS.md` / `TODO.md`
> (`pane --file <path>` renders that file instead). Bare `herdr-todo open` is an alias.
>
> `adapters install` also runs `herdr integration install pi|opencode|grok|kilo|droid`
> (best-effort) so Herdr detects those agents even when launched in a plain
> shell, which is what drives the auto-opened todo tab. Cline has no detection
> hook — start it with `herdr agent start --kind cline`.

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
poller, reinstalls the global adapters (todo + planning-todos skills, pi,
OpenCode), and reloads the Herdr plugin manifest. Cline's project-level
`.clinerules/todo.md` is copied per project.

The shared + planning skill `.md` files are **also re-synced automatically on
every Herdr start** by the plugin's `[[startup]]` hook (cheap plain copies into
`~/.agents/`, `~/.grok/`, `~/.pi/`; skipped when unchanged) — so adapters track
the installed plugin source without a manual `update`. `update` remains the way
to pull *source* changes and reinstall the package-based adapters (pi, OpenCode).

