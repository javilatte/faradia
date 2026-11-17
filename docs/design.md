# optimia: design

How optimia 2.x is built: the pieces, how they talk to each other, and the decisions that
are not obvious from the code.

## Overview

```
browser ──HTTP/WS──▶ server (server/index.js)
                       ├── security: Host, Origin and a per-run token
                       ├── ProjectRegistry ──▶ ProjectRuntime (one per repo, on demand)
                       │                        ├── project API (runtime/projectApp.js)
                       │                        ├── chat and task sessions (`claude -p`)
                       │                        └── terminal (PTY)
                       ├── workbenches (store/workbenchStore.js)
                       ├── MonitorService ──▶ TreeWatcher per repo and per task worktree
                       │        ├──▶ Timeline (monitor/timeline.js)
                       │        ├──▶ SignalEngine (monitor/signals.js)
                       │        └──▶ Metrics (monitor/metrics.js)
                       ├── wikis and knowledge (knowledge/)
                       └── explorer and trash (fs/)
```

Plain Node, no framework. The frontend has no build step: the project view is classic
scripts (`web/js/project/`) and the other views are ES modules (`web/js/app/`).

## Several projects

Each project has a `ProjectRuntime` with its sessions, its `mcp.json`, its log and its API,
served under `/api/projects/:id/*`. The id is a sha1 of the real path, stable across
restarts. `/api/*` without an id points at the launch project, for compatibility.

The project view picks its project with `?p=<id>`. Switching repos does not reload the page
(`web/js/project/switch.js`): it updates `currentProjectId` and `?p=` with
`history.pushState`, clears the chat and board state and asks again for settings, tasks
and chats. Every loader checks on return that the repo is still the same, so a slow answer
of the previous repo is dropped. The module views listen to `optimia:project-changed`.
Every WebSocket message carries `projectId` and each view filters its own.

optimia leaves no trace in the repo: `.optimia` is excluded in `.git/info/exclude` (the
`.gitignore` is not touched), and the Claude Code permissions of its own sessions live in
`.optimia/claude-settings.json` (chat and terminal) and
`.optimia/claude-settings-agents.json` (agents), passed with `claude --settings`. The
project's `.claude/` (team configuration) is never modified, and its `deny` rules still
add up to optimia's.

## Layered settings

So the workflow is the same in every repo while each keeps its own, settings have two
layers (`server/store/settingsStore.js`):

- **Global**, `~/.config/optimia/settings.json`: appearance, model and effort, local AI,
  shared instructions, the "Prohibido" list, security (sandbox), wiki and ECC choices.
- **Repo**, `.optimia/settings.json` (version 2): only the AI fields the repo changes, its
  own instructions and prohibitions (added to the global ones) and the permissions
  approved in its tasks.

`loadSettings()` returns the effective settings the sessions use. `PATCH /api/settings
{scope}` changes one layer; in the repo layer a value equal to the global one stops being
an override, `reset` inherits again and `promote` applies it to every repo. Agents and the
stage map have the same layers (default → global → repo).

Each repo's own knowledge is its memory (`.optimia/memory.md`). The internal `onboard`
task ("Conocer este repo") proposes it with a read-only agent; `POST
/api/tasks/:id/apply-memory` saves it and removes the study's worktree and branch.

## Agents

- `server/agents/catalog.js`: optimia's agents plus `.md` files with frontmatter, global
  (`~/.config/optimia/agents`) or per project (`.optimia/agents`), merged field by field:
  default < global < project. ECC's agents are one more base layer (ids `ecc-*`), off
  until needed.
- optimia's agents keep their ids, stages and access and follow the method of their best
  ECC counterpart (`ECC_METHOD` in the catalog): their prompt is their own role plus that
  method, and optimia's stage instructions win over it.
- `server/bridge/taskStages.js`: the `STAGES` table (access, default agent, whether the
  stage may ask) and `TASK_TYPES` with the pipelines. `decideAfterStage` is a pure
  function: a stage's outcome in, the task patch and the next stage out.
- `server/agents/stageMap.js`: which agent runs each stage (configurable). If the agent of
  an optional stage (verify) is off, the stage is skipped.
- `buildSessionOptions(..., agent)`: the agent decides engine, model, effort and role
  prompt. Local models are passed by their real name: the `claude` CLI 2.1.x forwards it to
  `ANTHROPIC_BASE_URL` as is, so several agents can use different local models at once.
- `server/bridge/localAi.js` detects Ollama (`/api/tags`) and LM Studio (`/api/v1/models`,
  with the port `lms server status --json` reports) and builds the environment of local
  sessions: a placeholder token instead of the claude.ai login, no `ANTHROPIC_API_KEY`, and
  the same local model for background requests.

## ECC

ECC (github.com/affaan-m/ECC, MIT) is copied into `vendor/ecc` by `scripts/vendor-ecc.sh`,
with its licence and source commit. It is not a Claude Code plugin. `server/ecc/library.js`
exposes its agents to the catalog and copies the skills (and, optionally, the commands) the
user enabled into `<data>/optimia/ecc/.claude/`; that folder goes to every session with
`--add-dir`, where Claude Code loads them. Each enabled skill adds its description to every
session's context, hence a default selection of general-purpose skills.

## Task delivery

- The manual `describe` stage ("Redactor de PR y Jira") drafts the PR description (first
  line `TÍTULO:`) or the Jira comment from the request, the plan or diagnosis, the verdict,
  optional notes and the branch diff against its base. It is stored in
  `task.delivery.{pr,jira}`; the user's edits go through `PUT /api/tasks/:id/delivery`.
- `server/bridge/delivery.js` pushes the branch (`GIT_TERMINAL_PROMPT=0`) and opens the PR
  with `gh pr create --body-file -`, or updates it with `gh pr edit`. Without `gh`, or
  outside GitHub, it returns the URL to open it (GitHub compare, GitLab merge request,
  Bitbucket PR). The provider comes from the remote's configured URL, not from `git remote
  get-url`, which applies `insteadOf` rules.
- `POST /api/tasks/:id/finish` ("Solo commit") ends a task on its branch. A task whose
  branch name already exists continues that branch (`existingBranch`); removing a task never
  deletes a shared branch or commits that are neither merged nor pushed.
- Without a remote, the card offers the local merge.

## Wikis and knowledge

- `server/knowledge/wikiStore.js`: wikis are markdown folders in
  `<data>/optimia/knowledge/wikis/{personal,projects/<key>}`; `<key>` comes from the git
  remote, so a project has the same wiki on every machine. Pages link with `[[Page]]` or
  relative `.md` links; the store resolves them for backlinks, search and the map.
- `server/knowledge/wikiUpdater.js`: after a committed task or a delivered report, one
  update at a time, the wiki agent edits the wikis from the commit and the task's plan,
  without Bash. It tries the local model first and falls back to a cheap Claude model.
- `server/knowledge/bundle.js`: the `optimia-knowledge` export (configuration, every wiki,
  each repo's memory). Items are keyed (wiki key + path, project key) and carry date and
  hash: importing adds what is new, the newer side wins and replaced items are backed up.
  It is the unit a future auto-sync will exchange.

## Attachments

`server/bridge/attachments.js` stores chat attachments in `.optimia/attachments/<chat>/`.
Images travel as image blocks. PDFs are referenced by path and page count, because Claude
Code's Read tool reads PDFs natively and by page range. DOCX, XLSX, PPTX and ODT text is
extracted to markdown with a small built-in ZIP reader. Small text files go inline; the
rest, by path.

## Supervision

**Why not recursive `fs.watch` on Linux.** Node's recursive mode puts an inotify watch on
every subfolder, `node_modules` included, and with several repos runs out of
`max_user_watches`. `TreeWatcher` watches folder by folder only:

- folders with tracked or new non-ignored files (`git ls-files`),
- the fixed folders of the watchlist (`dist/**` → `dist`),
- git metadata (`HEAD`, `index`, `refs/heads`).

A new folder is watched if git does not ignore it, and the files it already holds are
reported. On macOS and Windows the native recursive watcher is used instead, filtering
ignored folders with `git check-ignore`. Events are batched for 300 ms.

**Live diffs.** An agent writes in its worktree → `TreeWatcher` emits a batch →
`MonitorService` emits `activity` and, 400 ms later, the worktree's git state → the server
forwards both as `monitor_*` → the Changes view, if it is looking at that worktree, asks for
the diff again and repaints it keeping the scroll.

## Signals

`SignalEngine` is passive: it never blocks anything. For secrets it only scans what git
would commit (`git check-ignore`). If a sensitive file is **not** ignored, the signal says
so and is raised to high severity. A secret's value never leaves the scanner: only the rule
and `file:line` are kept. Signals are deduplicated for 10 minutes.

## Security

- The server listens on `127.0.0.1` and checks `Host` (DNS rebinding), `Origin` (CSRF) and
  a per-run token, in a header or a `SameSite=Strict` cookie named after the port.
- **Agents**, in layers:
  - Claude Code's OS sandbox (`sandbox.enabled`, `failIfUnavailable`) keeps Bash writes
    inside the worktree; `server/bridge/sandbox.js` checks its tools first and does not
    start an agent without it, unless the user turned it off.
  - A PreToolUse hook (`server/bridge/policy.js`, `policyHook.js`) blocks destructive
    commands anywhere in a command line and tells the agent why; the stage never stops.
    The card lists blocked actions and "Permitir" approves an exact command for the repo.
    Approvals reach the hook through the environment, fixed when the stage starts, so an
    agent cannot grant itself one. If the hook cannot run, plain deny rules replace it.
  - Commit, push, merge and rebase are never approvable: deny rules plus a git hook enabled
    through environment variables.
  - Read-only stages block the edit tools with `--disallowedTools`.
  - Task agents use `--strict-mcp-config`: only optimia's MCP server and the repo's
    `.mcp.json`, not the user's claude.ai connectors.
- The explorer resolves every path inside the repo (following symlinks), never touches
  `.git` or `.optimia`, never overwrites, and serves raw files with a `sandbox` CSP.
- A task's commit respects `.gitignore`: an ignored file the agent generated only goes in
  if the user ticks it.

## Tests

- `test/unit`: `node --test`, with real temporary git repos and XDG pointed at temporary
  folders (tests never touch `~/.config`).
- `test/*.bats`: the real launcher and HTTP API.
- `test/e2e`: Playwright against a fake `claude` (`test/e2e/fixtures/bin/claude`) that
  speaks stream-json and records its arguments and messages, and a fake `gh`.

## Interface design

The interface follows Apple's Human Interface Guidelines for macOS:

- **Window**: a sidebar (the logo, the workbench, the views and the repos) and a toolbar
  with the view's title and actions.
- **Color**: semantic tokens (`--label`, `--secondary-label`, `--separator`, `--accent`…)
  in `web/styles.css`, with dark, Increase Contrast and Reduce Transparency variants. Text
  contrast is at least 4.5:1, and states never rely on color alone.
- **Type**: Inter (variable, bundled in `web/fonts`, SIL OFL) with the macOS scale (13 px
  body, 10 px minimum). The logo is "Optimia" set in Doto, converted to SVG paths.
- **Controls**: `web/macos.css` unifies push buttons (one main button per view), pop-up
  menus, fields, segmented controls and focus rings.
- **Settings** apply at once, without a Save button.

## Portable configuration and updates

`server/config/portable.js` exports and imports the global configuration as
`format: "optimia-config"`, `formatVersion: 1`: global settings, global agents, the stage
map and signal preferences. Importing validates the file, shows a preview and backs up the
current one in `~/.config/optimia/backups/` (the last 10). `isFirstRun()` detects a new
install for the welcome sheet.

`server/config/updateCheck.js` asks `registry.npmjs.org` for the latest version at most once
a day (cached) and compares with semver. The request carries no user data; `updates.check`
or `OPTIMIA_NO_UPDATE_CHECK=1` turn it off, and the tests always do.
