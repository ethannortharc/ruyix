# @ruyix/agent-hub

Agents (智能体; the package and its code still say Agent Hub) for DeepSeek Harness 0.2.0-rc.2, web profile: an **agent pool** — agents that run on
**dsh**, **Claude Code** or **Codex**, each with its model, effort and skills — and the **jobs** they work on.
Sidebar → **Agents** (智能体 when dsh is in Chinese): three tabs — **Agents** (the default agent, a row per agent with
what it runs on, whether it can run now and how many steps use it; its detail beside: skills, the steps it takes by
workflow, its work), **Tasks** (what needs you, the jobs, a job's view) and **Runtimes** (the CLIs; a runtime the pool
needs that is not ready counts on the tab and marks its agents). Another panel opens a tab with window event
`agent-hub:open` { tab }. **Skills** — its own sidebar entry: the skill packs and who
uses each skill (agents and workflow steps).

## Agents and jobs

- An **agent** is what runs: an id (fixed once added: workflows name it), a display name, the runtime, model,
  effort, the skills it always has, notes the Lead reads, and — only where it must — "always full access" (Codex,
  whose read-only sandbox blocks MCP tools or cannot start on this machine). What an agent does in a task — its
  role, and the access that work needs — comes with the task, not the agent.
- The **default agent** (a dsh agent: it runs inside dsh) leads ad-hoc jobs; the assistants and the AI helpers of
  the other plugins run on it too (`agentHub.defaultModel()`). None set: dsh's default model.
- A **job** is one piece of work. From the panel (**New job**), a chat or the cloud, it gets a **fresh Lead
  session** (the default agent) that plans the work, assigns tasks to pool agents and reviews the reports; its last
  reply is the job's report. A service (the workbench) runs a **headless** job: no Lead planning, it assigns each
  step's task to the agent the step names, and names the agents it will use so they are checked before it starts.
- From a chat: `list_agent_pool`, `start_agent_job({ task, cwd? })`, `wait_agent_job({ id })`. The report comes back to
  that chat when the job settles (or as the wait's result).
- A job's Lead gets `assign_task({ agent, task, role?, access?, title?, after? })`, `wait_tasks`, `job_status`,
  `cancel_task`; dsh's own Agent Teams tools are hidden from it. A job settles when its Lead is idle and no task is
  open; talking to the Lead again reopens it and the next answer is delivered again.
- Every task starts a **fresh run** of its agent:
  - `dsh` — a spawn child of the job's Lead (`ctx.subagents.start`), model via `agentOptions`,
    role + skills as its `persona`, read-only via `toolFilter.deny`;
  - `claude` — `claude -p --output-format stream-json`, role + skills via `--append-system-prompt`;
  - `codex` — `codex exec --json -C <workspace>`, instructions + task on stdin;
  - `pi` — `pi -p --mode json`, the task on stdin, in a folder of its own for the run (`PI_CODING_AGENT_DIR`: the
    person's sign-ins and models linked in, the run's MCP server in `mcp.json` — pi's built-in MCP, declared to the
    model directly; an access allowlist names `mcp__<server>__*`, else pi drops those tools); its sessions stay in the
    person's folder, so a task resumes.
- **Model endpoints** (`endpoints.js`): where a CLI agent's model comes from when it is not its runtime's own sign-in.
  They are dsh's model providers (its settings, `llm-pi-ai`), the one list for the whole Ruyix, kept in Settings → 模型
  «模型接入点»: an address speaking OpenAI Chat Completions, OpenAI Responses or Anthropic Messages, its key, and the
  models ticked there (only those are shown and offered; ticked again any time). Agent Hub reads them (`endpointOfProvider`;
  a pi-ai catalog id without an address of its own is at its known one) and lists none of its own: Agents → Runtimes
  points to Settings. An agent names one (`endpoint`) and a model of it. pi takes all three (a provider in its run
  folder's `models.json`), Claude Code Anthropic's (`ANTHROPIC_BASE_URL`), Codex OpenAI's Responses (a model provider of
  its config); dsh runs its own models. The key is the provider's credential (`apiKeyEnv`): in a nookbox box the host's
  vault keeps it (the shell's `providers.js`), bound to the hosts that use it, and the box only a placeholder (the
  gateway makes it real on the way out); a model server on the host or the LAN (an IP, localhost) keeps it as it is. A
  run gets it in its environment (`RUYIX_ENDPOINT_KEY`, or `ANTHROPIC_API_KEY`), never in a file or on a command line. A
  runtime whose agents all use endpoints needs no sign-in of its own. Op `endpointTest`. Agent Hub's own endpoints from
  before (config `endpoints`) moved into the providers once (`providersFromEndpoints`: ids and key names kept; one that
  came with every model its address listed keeps the ones in use).
- **Sessions** (`sessions.js`, Agents → 会话, docs/design/sessions.md): an agent of the pool (Claude Code, Codex, pi), a
  folder, one conversation that goes on, and while it is in use a process that stays — Claude Code reads its messages as
  stream-json from stdin, pi takes RPC commands (`--mode rpc`); Codex still starts once a turn on its session id. Idle for
  20 minutes, the process ends; the next message starts it again on the CLI's session. Started by the person (the page),
  or by the main agent through the shell's system tools `session_list/start/send/read/stop/close` — at most 3 of its
  processes at once, a 4th only after the person said yes. Ops `sessions`, `sessionStart`, `sessionSend`, `sessionRead`,
  `sessionStop`, `sessionClose`, `sessionSeen`, `sessionRemove`. The page publishes the sessions and the pool's own jobs
  to the shell's work list (`@ruyix/shell/work`) for the desks.
  As the person's tasks (`task-feed.js`, docs/design/agent-tasks.md): every session the person or the main agent
  started, and every job, is a task of the workbench's — a turn that changed files waits for the person (to-confirm,
  the files its outputs), one that only answered is done; 再改 reaches the session (or starts a follow-up job); a
  session's task shows what happened in it (its timeline). The main agent's task tools (`task-tools.js`): task_list,
  task_look, task_confirm, task_revise, task_archive, on the shell's system tools.
  In a terminal (`mirror.js`): `ruyix session list | attach <id>` mirrors a session — its conversation as it goes, what
  is typed sent to it — through a socket of the hub's home (`sessions.sock`, 0600). In a box (or with RUYIX_MIRRORS=1)
  every session also has a window in tmux (`tmux -L ruyix attach -t ruyix-agents`) and a tab in Zellij's `ruyix-agents`.
- A task's **role** is its lane: one task of a role runs at a time within a job, roles in parallel. A run's prompt
  carries the role's last three reports in this job. Unwaited reports reach the Lead as one batched message.
- **Fallback**: a task may name a fallback agent; when its provider refuses the work, rate-limits it, runs out of
  quota or cannot serve the model, the task runs once more on the fallback.
- **Dependencies**: `assign_task({ …, after: [taskIds] })` — the task waits for those tasks and receives their
  reports. If an upstream task fails or is cancelled, the downstream task is cancelled and the Lead is told, so it
  can re-plan. The Workflow view draws these as dashed edges between tasks.
- An agent in use (a plugin says so: `registerAgentUses(fn → [{ agent, by, where }])` — the workbench's steps) or
  with running tasks is not deleted; editing one applies to the tasks that start after it.
- Before the pool there were standing teams: on the first start their members (and fallbacks) joined the pool, a
  Lead model became the default agent, and the teams stay readable for the tasks and settings that named them
  (`legacyTeam(name)`). An old `.team.json` imports the same way.
- Access levels:

  | | dsh | Claude Code | Codex |
  |---|---|---|---|
  | read | deny write/edit/bash tools | `--permission-mode dontAsk`, no Edit/Write/Bash | `--sandbox read-only` |
  | write | all tools | `acceptEdits` + Bash | `--sandbox workspace-write` |
  | full | all tools | `bypassPermissions` | `--sandbox danger-full-access` |

  Where Codex's bwrap sandbox cannot start, read/write Codex runs are refused (not silently unsandboxed) and the
  editor locks the agent to full.
- Effort (claude `--effort`, codex `model_reasoning_effort`): low · medium · high · xhigh (· max for claude).

## Skills

Agents (and the steps that give them skills for one task) name skills as `pack/skill` — a **skill pack** is a versioned set of skill folders (each with a `SKILL.md`):

- **bundled** with a plugin (its own `skills/` folder), versioned with the plugin, registered
  through the `agentHub` service (`registerSkillPack`);
- a **team git repository**, pinned to a commit and kept as an immutable snapshot under `~/.ruyix/agent-hub/skills/<pack>/<sha>`.
  The **Skills** page adds one, checks for updates (the commits and the skills they touch, who
  uses them), moves the pin or rolls it back, and lists the skills that are only on this machine or in a workspace.

A task resolves its agent's skills at the pinned versions and records them (`task.skills`). Claude Code agents get
them as a plugin of that session only (`--plugin-dir`, never installed globally); Codex and dsh agents get an index
and the text in their instructions. A shared agents file carries the git packs it names (source and commit):
importing it adds the missing packs at that commit. A `pack/skill` that does not resolve stops the job before it starts; a bare
name is looked up in the packs (and, when local skills are allowed, the job's workspace, then this machine).

**Skills from packs only** (the default; a switch at the top of the Skills page): agents get the skills in packs and
nothing local — as they will in a sandbox. Claude Code agents run with `--setting-sources local` (neither the user's
nor the project's settings: their skills, plugins and hooks stay out), Codex agents with their own `CODEX_HOME` (the
sign-in linked in; Codex still reads `~/.agents/skills`, which it cannot turn off yet), dsh agents without dsh's
`skill` tool. A bare name of a local skill is then not given (the task records it in `missingSkills`).

**Where each skill is used** shows under it on the Skills page: the agents that name it, and what other plugins
say they use it for (`registerSkillUses(fn → [{ ref, by, where: { en, zh } }])` — the workbench: the steps whose scripts
run it, the steps whose agent it is given to). An assigner may give an agent skills for one task
(`assign(…, { skills: ['pack/skill'] })`): resolved like the agent's own, recorded on the task.
Personal values (URLs with tokens, kubeconfigs, registries) never go in a skill: they are each plugin's settings.

## Panel

- Rail: attention (a Lead waiting / done unread, failed runs), the agent pool, the jobs.
- Agent pool: the default agent; each agent (runtime, model, skills, which workflow steps use it, its tasks so far);
  add, edit, delete; import / export file / share code (`.agents.json`, `dsh-agents:…`).
- New job: the brief and the workspace; the default agent leads it.
- Job view: **Workflow** (Lead → one lane per role → its runs → delivery, live tool activity), **Board**, **Roles**,
  **Report**; side panels for the Lead, a role and a task; assign a task to an agent, message the Lead, stop, archive.
- Languages: Chinese and English (`src/locale.js`). The header's 中 / EN switch is dsh's own
  language setting (`ctx.locale.setLocale`), so the whole dsh UI follows; this browser also
  remembers it, because dsh only saves the language on the Host for loopback browsers. Host
  errors shown in the panel carry a `code` + `params` and are translated there (`err.*`);
  the English `message` stays for agents and logs.

## How it works

- `index.js` (Host): `agentActivity` / `agentReport` projections; the pool, the job runtime and agent tools;
  `POST /api/agent-hub` ops `sync`, `models`, `saveAgent`, `deleteAgent`, `setDefaultAgent`, `exportAgents`,
  `importAgents`, `startJob`, `stopJob`, `assign`, `cancelTask`, `message`, the skill pack ops, `endpointTest`.
- `store.js`: SQLite (`~/.ruyix/agent-hub/hub.db`, `node:sqlite`) — the session mirror plus agent,
  config, job and task documents (and the old teams) under one global `rev`, so the panel delta-syncs with a single cursor.
  CLI run streams are kept in `~/.ruyix/agent-hub/runs/<task>.jsonl`.
- `runtimes.js`: CLI argv per access level, and parsers that turn Claude Code / Codex JSON
  streams into the same events as the dsh session log, so one fold renders every member.
- `src/` (Web, React 18 from the host), bundled by `build.mjs` with esbuild into `client.js`.
- A Host restart cannot finish runs: running tasks become "interrupted", queued ones restart.

## Develop

```sh
npm install --legacy-peer-deps      # build tooling only; nothing is needed at runtime
node build.mjs                      # src/ → client.js (page reload picks it up)
node check.mjs                      # Host self-check, with fake dsh services and fake CLIs
dsh plugin --profile web add "$PWD" # install (linked; needs pnpm)
```

`index.js` / `store.js` / `runtimes.js` changes need a `dsh web` restart, which interrupts
running agents and jobs — check nothing is running first.

## Known limits

- dsh members live under the Lead's agent: if dsh unloads the Lead, its running dsh members stop.
- Claude Code / Codex members inherit your CLI login and their own config (`~/.claude`,
  `~/.codex`); models there are free text, validated by the CLI at run time. On a model endpoint, the model is one of
  the endpoint's (listed from it, or written).
- Whether the nookbox gateway puts a placeholder back for a host port (a model server on the Mac) is not relied on: a
  local endpoint's key goes into the box as it is.
- The tasks of one job share its workspace; give parallel writers separate areas.
