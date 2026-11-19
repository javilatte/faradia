# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Added
- **Sync between computers** (Settings › Sincronización): settings, AI keys, agents, stages, instructions and notices stay the same on every computer. The copy lives in a folder the user already syncs (Google Drive for desktop, Dropbox, iCloud, Syncthing…) and is encrypted on the computer with a passphrase (scrypt + AES-256-GCM) before it is written; whoever stores the folder cannot read it. Changes sync a few seconds after they happen and every few minutes; on a conflict the newest wins and the other is kept in `~/.config/optimia/backups`. Turning it off can also delete the copy.
- **No stops when Claude runs out of usage**: the chat and running tasks go on with the local model in the same session, with the whole conversation, and go back to Claude when the limit resets.
- **Suggestions while you type**: a fast model (the local model while it answers within 3 s, else Claude Haiku with low effort) proposes the skill, agent or task type that fits the message. Tab accepts, Esc dismisses; nothing is applied on its own. They work in every chat mode and can be turned off in Settings › Claude.
- **Permissions in the chat**: what needs permission shows up as a card in the conversation (Allow, Always allow in this repo, Deny) instead of jumping to the terminal. In automatic mode (the default with Claude) only risky actions ask.
- **Built-in skills** for the chat and every agent: frontend-craft (optimia's checklist for interface work), unslop (Damir Sokolovsky, CC BY 4.0), security-audit (Cloudflare, MIT), plan-optimizer (Sean Geng, MIT) and ponytail with its review and audit (Dietrich Gebert, MIT), changed so it leaves no marker comments in the code.
- **Archive of finished tasks**: what was asked, how it ended, which agents and models ran it and their report, with search; kept 30, 15, 7 or 1 days, or forever.
- **What's new**: an optional tour on the first run (with help to connect an AI) and after each update.
- **Problem report**: warnings and errors of every repo and of the page, grouped by kind, kept on this computer without keys or message text, exportable from Settings › Registro.
- Agents can install dependencies: from their sandbox they reach package registries only (npm, PyPI, crates.io, Go, RubyGems, Maven).

### Changed
- Every session reads in parallel and makes its independent edits in one turn, checking once at the end.
- Agents may delete files they created in their worktree; tracked files stay protected.
- A task can end with its commit merged locally even when the repo has a remote, and the pull request can be drafted before the commit.
- Settings follow macOS System Settings more closely: rows with the control on the right, skills as grouped lists with switches, settings that apply at once.
- The chat folds the agent's steps into one line, opens with examples, and background shell commands no longer show up as agents.
- Larger logo in the sidebar and an "Opt" favicon that reads in browser tabs.

### Fixed
- Importing a configuration file now also brings the chat permissions, the archive retention, the wiki settings and the chosen ECC skills.
- Errors of tasks that could not start were only in the browser console; they are said in the chat.
- The verification stage could not report its progress.
- Task titles were cut in the middle of a word; build outputs were listed as generated files.

## [2.2.0] - 2026-11-18

### Added
- **Live agent activity**: every task card shows, as it happens, what the agent says it is doing, the files it reads, its edits (+/−), the commands it runs with their result (test summaries included), its to-do list, how much it is thinking, blocked actions and the end of each stage. The full feed stays a click away.
- **Generate the wiki from the repository**: a button in the Wiki view has the librarian agent explore the repo and write linked pages (architecture, modules, flows, data, API, development, glossary), shown live while it writes.
- Task worktrees reuse the dependencies already installed in the repo (`node_modules`, `.venv`, `vendor/bundle`), so the agents can build and run the tests without reinstalling. The link never ends up in a commit.
- A one-minute 4K video filmed from real agent runs, with its own synthesised soundtrack, and an animated demo at the top of the README.

### Changed
- Agents write in the language of your request (narration, reports, questions, commit and PR texts), and so does the wiki update that follows each task.

### Fixed
- The Changes view lists an agent's worktree as soon as the agent starts, without reloading.
- English interface: dates, optimia's chat notices, the Changes view, the dashboard and the reasons of blocked actions were still in Spanish.

## [2.1.1] - 2026-11-17

### Added
- **English interface**: Settings › Appearance › Language (Automatic, Español, English). Automatic follows the browser's language.
- The chat and every agent know where the project and personal wikis are and read them on demand (Read/Grep), instead of rediscovering what is already written there.

### Changed
- The default workbench is called "Mi espacio" (renamed from "Por defecto" on its own), and the workbench selector no longer shows the number of repos.
- Tighter, kerned Optimia logo.
- 4K screenshots in the README; the README and the older CHANGELOG entries are fully in English.

### Fixed
- optimia warns on start when the agents' sandbox is missing (`bubblewrap` / `socat` on Linux) and says how to install it.
- A flaky end-to-end test on macOS.

## [2.1.0] - 2026-11-17

### Added
- **Pull request delivery**: after the commit, the task card offers a Pull request tab (title, description, draft) and a Jira tab (a comment for the ticket). An agent drafts both from the request, plan, verification and diff; "Create PR" pushes the branch and opens it with `gh`. "Commit only" ends a task on its branch, and several tasks can share one branch.
- **Wiki**: a project wiki and a personal one (tree, search, link map, editing), updated by an agent after every committed task, with the local model when available, otherwise Claude Haiku.
- **Export and import all your knowledge** (configuration, wikis, memories) in one file, merged by date.
- **ECC (Everything Claude Code, MIT) bundled**: optimia's agents follow the method of their best ECC counterpart, its 72 agents are available (call any with `@` in the chat) and its skills reach every session.
- **Chat attachments**: PDF, Word, Excel, PowerPoint, text and any other file, sent to the context efficiently (PDFs read by page, Office text extracted to markdown, small files inline).
- **LM Studio** support next to Ollama, with detection and local models in the chat's model selector.
- Inter bundled (no font CDN) and the Optimia logo.

### Changed
- Switching repos no longer reloads the page; workbenches reopen their last repo; a "+" adds repos with the folder dialog, and optimia offers to `git init` a folder that is not a repo.
- Agents only stop to ask for missing context. Blocked actions never stop a stage and can be allowed from the card; commit, push, merge and rebase stay forbidden.
- Agents run in Claude Code's OS sandbox (`bubblewrap` + `socat` on Linux, built in on macOS); without it they do not start unless you turn it off in Settings › General.

### Fixed
- Local-model sessions no longer send your Claude credentials to the local server.
- `?token=…&p=<repo>` links keep the repo.

## [2.0.1] - 2026-11-15

macOS fixes.

### Fixed
- If the built-in terminal cannot start, optimia shows why in the UI instead of exiting; an error in any WebSocket message no longer brings the server down.
- The built-in terminal did not start on macOS (`posix_spawnp failed`): `node-pty` 1.1.0 ships its macOS `spawn-helper` without the executable bit. optimia sets it before opening the terminal and, if it cannot, explains how to fix it.
- On macOS, file watching could miss a file created right after its folder, so the dashboard, Changes and the timeline did not show it. macOS and Windows now use the system's native recursive watching, without changes inside folders git ignores; Linux still watches folder by folder.

### Changed
- CI runs every suite on macOS too.

## [2.0.0] - 2026-11-15

Supervision of agents and of several repos at once. Breaking change to the 1.x local API (see "Breaking changes").

### Added
- **Workbenches**: named sets of repos in `~/.config/optimia/workbenches.json`, added by hand or by searching a folder; chat and agents work in any repo of the workbench.
- **Configurable agents**: ten default agents (Planner, Implementer, Verifier, Reviewer, Commit writer, Researcher, Documentation writer, Debugger, Test writer and Auditor), each with its engine (Claude or local), model, effort, access and role prompt. They can be tuned, or your own created, per project or for all, and you choose which agent runs each stage.
- **New pipelines**: bug (diagnose, implement, verify), tests, audit (report only) and custom agent, plus a verification stage that runs tests, lint and build and gives a verdict. Each card shows which agent and model ran every stage.
- **Dashboard** with each repo's live git state, the agents' activity in their worktrees, the last 24 h of activity and recent signals.
- **Live diffs** (Changes) of repos and task worktrees: inline or side by side, with context or the whole file, Shiki highlighting and a change map.
- **Timeline** of files, commits, branches, watchlist, tasks, signals and orphaned changes, with filters and commit history.
- **Passive signals**: large deletes, sensitive files (flagged if git would commit them), possible secrets (own rules plus gitleaks when installed; the value is never stored) and test changes. With system notifications and a compact glance window.
- **Watchlist** per repo (plane 2) for files git ignores.
- **File explorer** with previews (markdown, code, image, audio, video, PDF), clipboard, rename, copy, move and delete with Undo, and a restorable trash.
- CI on GitHub Actions (lint, format, unit, bats, Playwright e2e and gitleaks), ESLint and Prettier, `docs/design.md` and `docs/roadmap.md`.
- `OPTIMIA_NO_OPEN=1` to start without opening the browser, and `--port` / `OPTIMIA_PORT` to set the port.
- Design following Apple's Human Interface Guidelines for macOS: sidebar with views and repos, toolbar with the view title, semantic colors with light and dark modes, Increase Contrast and Reduce Transparency, the system type scale, push buttons, pop-up menus, segmented controls and focus rings. Shortcuts ⌥1…⌥5 (views), ⌘, (Settings) and ⌃⌘S (sidebar).
- Settings and agents save at once, without a Save button, and Settings opens on the last pane visited.
- Before sending a task, the composer shows its stages and which agent and model will run each one.
- Task cards show the pipeline with each stage's state, agent and model; chat and reports render as markdown.
- "Suggest commit message" fills in a Conventional Commits message in the repo's language; without it, the type comes from the task type.
- Merging a task fast-forwards when the base has not moved, then removes its worktree and branch, and the task moves to "Done".
- Efforts `xhigh` and `max`.
- **Global and per-repo settings**: `~/.config/optimia/settings.json` holds what is shared (appearance, model and effort, local AI, workflow instructions and the "Forbidden" list) and each repo only what it changes; its instructions and prohibitions add to the global ones. Settings has an "All repos / Only this repo" switch (also for agents and pipelines), and each field says whether it is inherited, with "Reset" and "Use in every repo". Old `settings.json` files are migrated.
- **Configuration file**: Settings > General exports everything global (settings, shared instructions and "Forbidden" list, global agents, pipelines and signals) to a private JSON, without repos or memory, and without the local AI auth header unless asked. Dropping it on the window imports it, after a preview and a backup. A new install offers it in a welcome sheet.
- **New version notice**: optimia asks the npm registry at most once a day and shows a notice in the toolbar with the update command and the release notes. Off in Settings > General or with `OPTIMIA_NO_UPDATE_CHECK=1`.
- **Learn this repo**: a read-only agent studies the repo (commands, structure, conventions, pitfalls) and proposes its memory, saved with one click. A new repo's empty board suggests it.

### Changed
- Requires Node 22 or later.
- Local models are passed by their real Ollama name, without the `claude-haiku-4-5` alias, so each agent can use a different local model at once.
- `web/app.js` is split into `web/js/project/`; the new views are ES modules in `web/js/app/`.

### Fixed
- Every stage gets the user's original request, not only the previous stage's plan.
- An action forbidden to agents no longer stops the stage: the agent gets the denial and carries on.
- Opening Settings no longer wipes what you start typing while it loads.
- The tasks MCP server starts with the same `node` as optimia (with nvm, `node` may not be on the PATH).
- The timeline ignores temporary files of atomic writes and editors.

### Security
- The local API and the WebSocket check `Host` (DNS rebinding), `Origin` (CSRF) and a per-run token (header or `SameSite=Strict` cookie).
- optimia no longer writes to the repo: its sessions' permissions (the "Forbidden" list included) live in `.optimia/claude-settings*.json`, passed with `claude --settings`. It used to rewrite `.claude/settings.json` (shared project configuration) and copy it into worktrees, where it ended up in commits. A `.claude/settings.json` generated by older versions and not tracked by git is removed.
- `.optimia` is excluded in `.git/info/exclude` instead of editing the repo's `.gitignore`, and the `.codegraph` link is only created when CodeGraph is enabled.
- Task agents do not inherit the user's claude.ai MCP connectors (Gmail, Drive, Slack…): only optimia's MCP server and the repo's `.mcp.json` (`--strict-mcp-config`).
- Read-only stages block the edit tools explicitly.
- A task's commit respects `.gitignore`: an ignored file only goes in if ticked on the card.

### Breaking changes
- API clients must send `X-Optimia-Token`: the token is in the link optimia prints on start.
- A specific project's API lives at `/api/projects/:id/*`; `/api/*` still points at the launch project.

## [1.0.1] - 2026-11-01

### Added
- Per-project log in `.optimia/logs/optimia.log` (one JSON per line, rotated at 5 MB): API requests, task stages, denied permissions, file changes, commits, merges, questions and answers (text cut at 500 characters).
- A "Log" pane in Settings to read it, with filters for file changes, questions and answers.

### Fixed
- Merging a task no longer requires switching the main checkout's branch: it happens in a temporary worktree on the base branch.

## [1.0.0] - 2026-10-31

Full rewrite of optimia's workflow. Breaking change.

### Added
- Local web UI: `optimia` starts a Node server (HTTP + WebSocket) and opens the browser instead of a terminal wizard.
- Live chat with a real `claude` CLI process (long-lived, NDJSON over WebSocket), multi-turn within one session.
- Local AI bridge through Ollama (`/v1/messages` endpoint compatible with the Anthropic Messages API).
- Images and screenshots in the chat (paste and drag and drop), sent as inline image blocks.
- Settings panel: Claude model/effort, local AI, Instructions, Memory (`.optimia/memory.md`), No-go (`permissions.deny` patterns) and Skills (`.claude/skills/`).
- Automatic migration of a project's existing preferences (`.optimia/system-prompt.md`, `permissions.deny` of `.claude/settings.json`), with a preview before applying.
- Kanban board of coding agent tasks, with a git worktree per task.
- `bin/optimia` rewritten as a thin Node launcher: creates `.optimia/`, offers to enable/initialize/sync CodeGraph, and starts the server.

### Removed
- Support for opencode, Gemini CLI, GitHub Copilot CLI and `headroom`. Only **Claude Code** and **local AI** (Ollama) remain.
- The interactive start-up wizard (`ask_quick_questions`) and the `tools`/`config`/`repos`/`agents` CLI subcommands: configuration lives in the web UI.
- `openwiki` and the generation of `AGENTS.md`/`GEMINI.md`/`security.md` for other tools.

### Changed
- `optimia` no longer uses the Claude API directly: it always drives the real `claude` CLI as a subprocess.
