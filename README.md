# optimIA

[![npm](https://img.shields.io/npm/v/@javilatte/optimia?logo=npm&style=flat-square)](https://www.npmjs.com/package/@javilatte/optimia)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square&logo=node.js)](https://nodejs.org/)
[![macOS](https://img.shields.io/badge/macOS-tested-brightgreen?style=flat-square&logo=apple)](https://www.apple.com/macos)
[![Linux](https://img.shields.io/badge/Linux-tested-brightgreen?style=flat-square&logo=linux)](https://github.com/)
[![Windows](https://img.shields.io/badge/Windows-untested%20%2F%20WIP-yellow?style=flat-square&logo=windows)](https://www.microsoft.com/windows)

Run `optimia` in any project directory. It starts a local web server and opens a
dashboard in your browser where you can **direct** coding agents and **watch**
what they do, across every repo you work on:

- **Chat** against a real **Claude Code** session (or a local model via **Ollama**).
- **Agents with their own model**: ten default agents (planner, implementer,
  verifier, reviewer, debugger, test writer, auditor…) wired into task pipelines,
  each with its own engine, model, effort and role prompt — plus your own agents.
- **Workbenches**: group repos, auto-detect them under a folder, and run chats and
  agents in any of them.
- **Live supervision, read-only**: git state per repo, a live diff viewer (watch an
  agent write in its worktree), a timeline, passive signals (large deletes,
  sensitive files, possible secrets, test changes), metrics, desktop notifications
  and a compact glance window.
- **File explorer** with previews and undoable operations.

```
$ optimia

optimia running at http://127.0.0.1:54213/?token=… (project: /path/to/your-project)
```

No terminal wizard: everything (models, agents, local AI, instructions, memory,
permission rules, skills, signals, watchlists) is configured in the web UI.

---

## Installation

```bash
npm install -g @javilatte/optimia
```

If you get a permission error (common on Linux with system Node), install to your user prefix instead:

```bash
npm install -g @javilatte/optimia --prefix ~/.local
```

Make sure `~/.local/bin` is in your `PATH` (`echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`).

Or run without installing:

```bash
npx @javilatte/optimia
```

---

## Requirements

| Tool | Required | Purpose |
|---|---|---|
| `node` ≥ 22 | yes | runs the server and the CLI launcher |
| `git` | yes | worktrees for agent tasks, and all repo supervision |
| [`claude`](https://claude.ai/code) (Claude Code CLI) | yes | chats and agents are real `claude` subprocesses — optimia never calls the Anthropic API directly |
| [Ollama](https://ollama.com) | optional | local models for the chat or for any agent (Anthropic-Messages-compatible endpoint, Ollama ≥ 0.14) |
| [`gitleaks`](https://github.com/gitleaks/gitleaks) | optional | extra secret detection rules on top of the built-in ones |

---

## The views

| View | What it does |
|---|---|
| **Proyecto** | Chat with Claude and the kanban of agent tasks for the selected repo. |
| **Dashboard** | One card per repo of the active workbench: branch, ahead/behind, changes, lines ±, last commit, live activity (including agents in their worktrees), 24 h activity and recent signals. |
| **Cambios** | Live diff of any repo or task worktree: inline or side by side, with context or the whole file, syntax highlighting and a change map. It refreshes by itself while files change. Commits open here too. |
| **Timeline** | Chronological feed of changed files, commits, branch switches, watchlist events, agent task updates, signals and orphaned changes, with filters and the commit history of each repo. |
| **Archivos** | File tree with previews (markdown, code, images, audio, video, PDF), copy path, a file clipboard, rename/copy/move/delete with **Undo**, and a trash you can restore from. |

The **glance** button in the top bar opens a small window with one line per repo,
for a corner of your screen.

---

## Agents and pipelines

Every task runs as a pipeline of stages, each one handled by an agent in the task's
own git worktree:

| Task type | Pipeline |
|---|---|
| Código (`coding`) | plan → implement → verify |
| Bug (`bugfix`) | diagnose → implement → verify |
| Tests (`tests`) | plan → write tests → verify |
| Documentación (`documentation`) | research → (choose format and target) → write |
| Auditoría (`audit`) | audit → report (no changes) |
| Agente propio (`custom`) | one stage with one of your agents |

Review and commit preparation run on demand once a task is ready. The verifier runs
the project's tests, lint and build and gives a verdict; disable it to skip that
stage. Each task card shows which agent and model ran every stage.

In **Ajustes → Agentes** you can change any agent's engine (Claude or local), model,
effort and role prompt, choose which agent runs each stage, and create your own
agents — for this project or for all of them. Agents are plain Markdown files with
frontmatter:

```
<project>/.optimia/agents/<id>.md      this project only (wins)
~/.config/optimia/agents/<id>.md       every project
```

Agents can use different local models at the same time: the model name is passed
straight to Ollama.

Agents can never commit, push, merge, rebase or run destructive commands: a deny
list and a git hook block them. When an agent tries one, it gets the denial and
carries on another way, as in Claude Code. Read-only stages cannot edit files. Task
agents only see optimia's MCP server and your repo's `.mcp.json`, not the
connectors of your claude.ai account.

Commit and merge are always your action, from the task card. "Proponer mensaje de
commit" fills in a Conventional Commits message in the repo's language; the commit
respects `.gitignore` (ignored files only go in if you tick them). Merging
fast-forwards when it can, then removes the task's worktree and branch.

---

## One workflow, every repo

Configuration has two layers, so every repo works the same way and each one can
still have what is its own. Settings has a **Todos los repos / Solo este repo**
switch:

| | All repos (global) | This repo |
|---|---|---|
| Model, effort, local AI | the default for every repo | only what this repo changes; each field says whether it is inherited, with **Restablecer** and **Usar en todos los repos** |
| Instructions | the common workflow (commit style, how to verify, language…) | extra instructions, added after the global ones and winning on conflict |
| Prohibido (no-go) | denied for every repo | added on top of the global list |
| Agents and pipelines | which agent and model runs each stage | per-repo overrides |
| Memory | — | the repo's own knowledge: commands, structure, conventions, pitfalls |
| Appearance, signals | global | — |

**Conocer este repo** (Ajustes → Memoria, or the empty board of a new repo) runs a
read-only agent that studies the repo and proposes its memory; you save it with one
click and can edit it later. Quick changes from the composer (model, effort) are
stored where the value lives: in the repo if it overrides it, otherwise for all repos.

Settings saved by older versions (a full copy in every repo) are migrated on first
read: only what differs from the defaults stays as a repo override.

### Your configuration file

**Ajustes → General → Exportar configuración…** saves everything global in one
JSON file: settings, common instructions and no-go list, global agents, the stage
map and signal preferences. It leaves out your repos, their memory and anything
tied to this machine; the local AI auth header only goes in if you tick it. Keep
the file somewhere private — it holds your instructions and your agents' prompts.

To import it, **drop it anywhere on the optimia window** (or use Importar
configuración…). optimia shows what will change and backs up the current
configuration to `~/.config/optimia/backups/` first. On a fresh install, the
welcome sheet offers exactly that.

### Updates

optimia asks the npm registry at most once a day whether a newer version exists and
shows a notice in the toolbar with the install command and the release notes. Turn
it off in Ajustes → General, or with `OPTIMIA_NO_UPDATE_CHECK=1`.

## Supervision

Supervision is **read-only**: optimia never writes to a repo to monitor it.

- **Plane 1** — git state from `git status --porcelain=v2`, refreshed when files or
  `HEAD` change.
- **Plane 2** — a per-repo **watchlist** of patterns (`.gitignore` syntax) that are
  reported even when git ignores them: `.env`, keys, build output…
- **Signals** — passive, never blocking:
  - large deletes (lines or files at once),
  - sensitive files (marked as exposed when git would commit them),
  - possible secrets in files git would commit (built-in rules plus gitleaks if
    installed; the secret value is never stored or shown),
  - test changes, especially by an agent.
- **Orphaned changes** — uncommitted work left untouched for a while (30 min by
  default).

Thresholds, rules, notifications and the watchlist live in
**Ajustes → Avisos y vigilancia**. Folders are watched one by one (not with a
recursive watch that would put a watcher on every `node_modules` folder).

---

## Security

The server listens on `127.0.0.1` only, and every API and WebSocket request must
pass three checks:

1. the `Host` header must be loopback with the real port (blocks DNS rebinding),
2. the `Origin`, when present, must be optimia itself (blocks CSRF),
3. a per-run token, sent as `X-Optimia-Token` or as a `SameSite=Strict` cookie set
   by the link optimia prints on start.

File operations stay inside the repo (no absolute paths, `..`, or symlinks pointing
out), never touch `.git` or `.optimia`, never overwrite, and raw files are served
with a sandbox CSP.

---

## Where state lives

```
<project>/.optimia/              per project (excluded from git automatically)
├── settings.json                only what this repo changes, its own instructions and no-go list
├── claude-settings*.json        permissions for optimia's own claude sessions (--settings)
├── memory.md                    the repo's knowledge, included in every session's system prompt
├── tasks.json, chats.json       kanban and chat state
├── agents/                      project agents and stage map
├── worktrees/                   one git worktree per agent task
└── logs/optimia.log             activity log (Ajustes → Registro)

~/.config/optimia/               global
├── settings.json                appearance, model/effort, local AI, common instructions and no-go list
├── workbenches.json             workbenches and their repos
├── agents/                      agents for every project
├── watchlists.json              plane 2 patterns per repo
└── preferences.json             signals, thresholds, notifications

~/.local/share/optimia/
├── timeline/events.jsonl        the timeline
└── trash/                       files deleted from the explorer
```

optimia leaves your repo alone: `.optimia` is excluded through `.git/info/exclude`
(never your `.gitignore`), and the Claude Code permissions of its own sessions —
including the "Prohibido" list — live in `.optimia/claude-settings*.json` and are
passed with `claude --settings`, so your project's `.claude/` is never touched.

---

## CLI

```
optimia              Set up .optimia/, start the server, open the browser
optimia --port 4777  Use a fixed port (default: a free one); also OPTIMIA_PORT
optimia --version    Print version
optimia --help       Print help
```

`OPTIMIA_NO_OPEN=1` starts the server without opening a browser (handy over SSH).

Keyboard: ⌥1…⌥5 (Alt on Linux and Windows) switch views, ⌘, (Ctrl+,) opens
Settings and ⌃⌘S (Ctrl+Alt+S) shows or hides the sidebar.

---

## Development

```bash
npm ci
npm run lint            # ESLint
npm run format:check    # Prettier
npm run test:unit       # node --test
npm run test:bats       # launcher and HTTP integration tests
npx playwright install chromium
npm run test:e2e        # Playwright, against a fake `claude` CLI
```

The design is described in [docs/design.md](docs/design.md) and what comes next in
[docs/roadmap.md](docs/roadmap.md).

### Releasing

1. Bump `version` in `package.json`, add the entry to `CHANGELOG.md` and merge to `main`.
2. Tag it and create the GitHub release: `git tag -a vX.Y.Z -m "optimia X.Y.Z" && git push origin vX.Y.Z`,
   then `gh release create vX.Y.Z --title "optimia X.Y.Z" --notes-file <notes>`.
3. Publishing the release runs `.github/workflows/publish.yml`, which checks that the tag
   matches `package.json`, runs lint and tests and publishes to npm with Trusted Publishing
   (no npm token; the package gets a provenance attestation). To publish an existing tag by
   hand: `gh workflow run publish.yml -f tag=vX.Y.Z`.

---

## License

MIT
