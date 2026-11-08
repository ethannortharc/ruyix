# @ruyix/workbench

Workflows run by a team of agents, step by step. Every step, tool call and approval goes into a hash-chained evidence
ledger; anything that leaves the machine waits for a person's approval; a run can be stopped, resumed, and read back as
a report. The engine knows no domain: a **domain pack** (its own dsh plugin) brings workflows, tools and the actions that
run on approval, and joins through the `ruyixWorkbench` service.

The package is one dsh plugin with two halves: the server (`index.js`, `lib/`) and the panels (`src/` → `client.js`): the inbox,
the runs, the workflows and the settings tab. A pack's own client adds its review cards, status blocks and settings form
(below, "For the panels").

```
index.js            the plugin: packs, the API, the service, the shell part, the MCP bridge     createWorkbench(ctx, opts), apply
pack.js             definePack(pack): the checked, filled-in form of a pack
lib/engine.js       the step loop, agent tasks (Agent Hub), approvals, resume, cancel, timeouts
lib/workflows.js    a person's workflows as data: validate, compose, installed scripts, files
lib/person.js       the person's part of a run: a person step (review, input, decide, do), its wait and reminder
lib/review.js       a review with a loop of its own: comments where they point, the agent revising in the step, round after round
lib/results.js      a run's results: the 结果 step (`use: 'output'`), what the results are, comments on them, going on again from a step
lib/pages.js        a web page of the folder with its own files put in, for the viewer's frame of no origin
src/viewer.jsx      the viewer: files by kind (document, lines, image, PDF via vendor/pdfjs, web page, video), comments where they point
lib/messages.js     the agents' messages to each other (core/messages): a space per run, three tools, a skill — not the ledger
lib/needs.js        what a workflow needs (agents, pinned skill packs, connections by type, models, scripts), this
                    machine's bindings, readiness before a run starts
lib/flow/            script steps: runtime.js (the durable journal, where the script runs), guest.mjs (the script's own realm), worker.mjs,
                    stage.js (what a step may do through the engine), check.js + names.js (the script read without running it)
lib/toolbox.js      the command-line tools a run's steps use beyond the image's: a step names them (`cli`), mise installs them into the home
lib/aiwork.js       the AI work done here: Agent Hub's tasks, the runs' steps, the workbench's own model calls (ai-calls.jsonl)
lib/tools.js        the agent tools (eight in the core; three more where agents message each other), stage_result validation
lib/store.js        SQLite documents + the ledger (+ artifact files)
lib/conversations.js  conversations.db: threads and their entries (found by words: FTS5), summaries, kept days, export; the old `chat` table taken over
lib/subject.js      the request: form fields, attachments;  lib/human.js  when a step asks the person on its own (help_needed, a low confidence, stuck)
lib/settings.js     home folder, settings (core + a block per pack), the command runner
lib/workflow-info.js  who does each step; what Agent Hub's Skills and Agents pages show
lib/assistant.js    the standing conversation: one kept thread, on a dsh session or a pool agent, `workbench_*` tools
lib/translate.js    zh / en translation with a cache;  lib/llm.js  one model call (each call reported to the AI-work log)
lib/mcp-server.mjs  stdio MCP server for Claude Code / Codex agents → the workbench's tools endpoint;  lib/mcp-client.mjs  how it is asked (a Unix socket)
workflows/common.js intake, report, decision action, header, renderReport;  workflows/blank.js  the core's base workflow;  workflows/task.js  one agent does a request
skills/workflow-create/  the skill that teaches the assistant to write a workflow
lib/file.js         a run's artifact file over HTTP: streamed, Range, only what the ledger names
src/                the panels (React, bundled by build.mjs into client.js): main.jsx is the entry; runs, ledger, gallery,
                    approvals, notices + inbox.js (the inbox's slots), newrun, workflows + wf-editor + wf-model (the canvas),
                    settings, metrics, chat (the conversation: the shell's chat sheet and the Chat page) + chat-state.js
                    (how it is doing, for the shell), locale, styles.css
```

## Data

`~/.ruyix/workbench/` (`RUYIX_WORKBENCH_HOME` moves it):

| path | what |
|---|---|
| `workbench.db` | SQLite: `docs` (kinds `run`, `approval`), `evidence` (the ledger), `translations` (a home from before also has `chat`, the conversation's record then: left as it is, taken over into `conversations.db`) |
| `conversations.db` | SQLite: `threads` (the standing one `main`), `entries` (+ `entries_fts`, a trigram index of their words), `summaries`, `memories`, `meta` |
| `runs/<runId>/` | artifacts the ledger names (path + sha256); `report.md`; `work/` is the agents' folder (`run.dir`: they read the attachment copies there and write what they like); `out/` is the engine's and the pack's own (`run.outDir`: cards, renders, voice files — never inside `work/`, where an agent may have left a link); `versions.git/` the run folder's versions (below) |
| `settings.json` | only what differs from the defaults |
| `workflows/<id>.json` | a person's workflows (`.history/` keeps replaced ones) |
| `scripts/<name>/<version>/` | installed scripts: `manifest.json { name, version, entry, description? }` + the entry |
| `assistant.json` | the standing conversation's state: its current dsh session (since when, how much of it is on record), the model or pool agent it runs on, a pool agent's CLI session |
| `bindings.json` | this machine's bindings of connection needs: `{ types: { <type or type:name>: connection }, workflows: { <id>: { … } } }` |
| `ai-calls.jsonl` | the model calls the workbench made itself (model steps, translations, packs' `callModel`): one line each — kind, model, time, tokens, cost, `by` (`<run>:<step>`); past 4 MB the newest 20 000 lines stay |
| `ui-runtime/` | the connectors plugin's Playwright (not touched here) |

`ruyix data export / import` (core/shell) moves `conversations.db`, `workbench.db`, `runs/` and `assistant.json`; `ruyix chat threads | memories | export` reads the conversations as they are.

## Workflows

A workflow object (`pack.workflows.<id>`, or the core's `blank`):

```js
{ id, title, description?, noun?,                 // id is global: 'blank', '<packId>.<id>'; noun: "note" in the agents' briefs
  input?: [{ name, type, label?, options?, required?, default? }],   // the new-run form (below)
  insertFrom?,                                    // a person's own steps may go after this step (default: the first step)
  success?, verdicts?, levelOf?(run),             // the verdict level that counts as success (default 'done'); { level: wording }; the level the report gives when no step set one
  folder?,                                        // the name of the form field that names a host folder the agents work in (default: the run's own)
  validateInput?(subject),                        // '' (fine), a message, or a list of messages; default: a title or a text
  stages: [{ key, owner, title?, optional?, final?, tools?, validate?(result, c), run(w) }],
  roles: { <owner>: { agent, fallback?, access: 'read'|'write', text }       // an agent of the pool
           | { kind: 'model', model: '<source>:<model>', text } },          // one model call (below)
  actions: { <action>: async c => result },       // pack.actions are merged in; `decision` is always there
  report?({ run, workflow, evidence, chain, approvals }) → Markdown }   // default renderReport
```

- **Script steps with a `write` connection** need a person's `approval` step before them on their path (the main line, or earlier
  in their own route): `workflowValidate` / `workflowSave` refuse it otherwise. What the connectors hand a script never reaches the
  ledger: its output is cleaned of the values, base64 / URL-encoded forms of them, the contents (and secret-looking lines) of a file a
  variable names (a kubeconfig), and a `user:password` pair as a Basic authorization header takes it (`secretsOf`, `lib/workflows.js`).
- `blank` = `intake` → *steps of the person's own* → `report`. A person builds on it (or on a pack's workflow) in the
  workflow editor: `{ id, title, base, packs?, steps: [{ use: '<base step>' } | agent | model | script | approval | person | branch | parallel | flow] }`
  (guide: `skills/workflow-create/SKILL.md`). A definition is a **draft** until enabled; a run keeps the definition it
  started with (`run.workflowDef`).
- `task` = `intake` → *one agent does the request* → `report`: the agent hands back done / partial / blocked, what is done, what is
  left and the files (`run.outcome`); the verdict is `completed`, `partial` or (blocked, the person is asked for what it needs) `need_info`.
  Its form has an optional `folder` field: a host folder to work in (`run.folder`; the agents' job and script steps start there), else the run's own.
- `owner` is `'system'` or a role; a role's agent is a default, a person picks another in the settings (`steps`).
- **Model steps.** A role with `kind: 'model'` is not an agent: its step calls a model once (`w.model`), no tools, no
  Agent Hub job — for work whose input is all there (rewriting, summarising, translating), at a fraction of an agent's
  tokens. Its model is a reference `"<source>:<model>"` (`lib/models.js`): `dsh:<provider>/<model>` goes through dsh's
  model service; `<connection>:<model>` through a connection of the Connectors page that speaks the OpenAI chat API
  (`POST <address>/chat/completions`, e.g. `openrouter:anthropic/claude-sonnet-5.5`). The model in use is the person's
  pick (`steps[workflow][step].model`), else the role's, else the settings' `model`. A run does not start while a model
  step it will take has no model, or names a connection that is not there. A person's `model` step: `{ id, title,
  instructions, model? }` — the request, what the earlier steps handed back (`outputsText`) and the instructions go in,
  the answer (Markdown) is its result (`run.outputs[id].summary`); it may stand in a route or a parallel lane.
- **Person steps** (`lib/person.js`). Ruyix works for one person: a person step asks *them*, as a card in the inbox, and the
  run waits at the step (`run.status 'waiting'`, `waitingFor` the card) until it is answered — `{ id, title, use: 'person', ask,
  text, wait? }`: `review` (a decision card: Approve, Ask for changes — when it names `back`, the run goes back to that step and the
  card's `comment` lands in that step's brief as "what the person said" — or Stop), `input` (a `help` card: the answer is
  `run.outputs[id].answer`, and every later brief hears it), `decide` (`options: [{ label, to? }]` — a choice with `to` sends the run
  back there; `run.outputs[id].choice`), `do` (a `help` card the person marks done, with a note). `wait` (hours, default 24 for
  input, 72 for do, none for review and decide; 0: none): past it the person is reminded **once** — the card gets
  `payload.remindedAt`, the ledger a gate entry, the inbox a notification and an "overdue" mark — and the run keeps waiting:
  nothing is decided by the clock, nobody else is asked. Rejecting the card stops the run there; a run that ends while it waits
  closes the card. A review counts as the person's yes before a script that writes through a connection; a person step
  stands on the main line or in a branch's route, never in a parallel lane. What a person said goes in `run.guidance`.
- **A step asks the person on its own** (`lib/human.js`). Any step (not a person step) can end with a `help` card of kind `agent` (its
  agent called `help_needed`: what it needs and, citing evidence, what it tried), `low` (its `confidence`, handed back with its
  result, is under the bar: `human: { below }`) or `stuck` (it failed where the run would stop: `human: { stuck: true }`, a
  built-in step's default — `task`'s work step has it; a definition sets `human: { stuck?, below?: 1–100, wait?: 0–720 }` on a step).
  The run waits at the step (`status 'waiting'`, the step `running` with `stage.asking` the card) for the answer: `retry` (the
  step runs again, the person's words in its brief: `run.guidance`), `continue` (its outcome stands) or stop (the card's `answer`,
  or rejecting it). Meanwhile the person may ask the step's agent about it (`askHelp {id, text}` → `approval.chat`): it answers
  from the run's record, read only (`ask`, a pseudo-step with `wb_context` and `evidence_get` only). A step asks at most three
  times in a run (`run.helps` records each); past `wait` hours (default 24) the person is reminded once and the run keeps
  waiting — nothing is decided by the clock. A run cut short by a restart waits again for the same card, it does not run the step again.
- **What a workflow needs** (`lib/needs.js`): its agents (each in the pool; a fallback not in the pool only warns), its skills
  (the packs its steps use are pinned in `definition.packs` when it is saved — a git pack's commit, a bundled pack's version, a
  pack's per-skill versions — and installed at those pins on a machine that lacks them), a script step's connections — by type
  and level, `connectors: [{ type, level: 'read' | 'write', name? }]`, bound on each machine (this workflow's binding, the default
  for the type, else the only connection of the type; the older `{ <connection id>: level }` still names one connection) — the
  models its model steps call, the installed scripts it runs and its command-line tools. Readiness (`workflowReadiness`) is worked out before every
  run starts (`prepare` in the engine): what can be installed is installed first, and a run that still lacks something does not
  start (`workflowNotReady`, `params.what` says what). A pack workflow's own connections (`pack.needs`) are listed with it but
  never stop a start (its actions need them later). The person's enabled workflows' connection needs go to the connectors
  plugin (owner `Workbench workflows`): the Connectors page shows what uses each connection, the inbox's System tab a need no
  connection meets.
- **Script steps** (`use: 'flow'`, `lib/flow/`; main line only). A step whose body is a short JavaScript — `await wf.step('name', s =>
  s.agent('role', prompt) | s.sh(cmd) | s.script('name@1', args) | s.ask(question, { options }) | s.evidence(title, data))` — with loops
  and conditions in code, reading what the steps returned. Its step's definition: `{ id, title, source, agents: { <role>: { agent,
  fallback?, access, instructions? } }, params: { <name>: { title, default } }, cli?, onFail, human? }`. The script runs in a VM realm of
  its own that sees only `wf` (no process, modules, network, timers, `eval`; `Date.now()`, `new Date()` and `Math.random()` are refused:
  `wf.now()` / `s.now()` are kept); in dsh's confined PTC process (`ptcRuntime`, a read-only sandbox without the home or the environment)
  when dsh has one, else a worker thread, stopped by ending the thread. A script that spins for ever after an `await` is ended by the host: when
  its thread has not answered a ping, or it has asked for nothing while none of its calls is at work, for the settings' `agentTimeoutMinutes`, the
  step fails saying so. Everything the script asks crosses as JSON, and what a step does
  is the engine's, under this machine's rules: an agent of the pool (the role's agent, `stage_result`, one at a time), a command (bash in the
  run's folder; recorded in the ledger), an installed script, a person's card (`s.ask`: an answer, or one of the options), a note in the ledger.
  **Each step is kept** as it begins, ends or fails (`run.flows[<step>]`, written at every change; the steps show under it on the run page,
  `stage.flow`): a run that stops — a restart, a crash, a stop and a resume — starts the script again from the top, every step already done
  answers with its kept result (a step that fails is tried again up to its `retries`), and the run goes on from the first step not done; a
  step cut short runs again, so each is to be safe to repeat. A person's stop (in a card, or rejecting a decision an agent asked) ends the
  script at once and the run; a choice that sends the run back (a decision's `revise`) ends it there and the engine takes the run to that
  step; the agent's own blocking decisions are waited for before the script's next step. `run.params` (`startRun({ params: { <step>: { <name>: v } } })`)
  override a step's parameters' defaults. Run again from the step by choice (`resumeRun({ from })`) or sent back: its journal starts over.
  The static check (`checkFlow`) says what a script may not do before it is saved; `workbench_workflow_try` runs it with stand-ins
  (nothing is asked or run) and reports the steps it went through. Readiness lists each role's agent and the installed scripts the script runs.
- **Command-line tools** (`lib/toolbox.js`). A step of a person's workflow (an agent, script or base step) names the tools it
  uses that the image does not have: `cli: ['shellcheck@0.11.0', 'golangci-lint', 'pipx:bandit']` (`name`, `name@version`, or
  `backend:package[@version]`, the backend `core aqua github gitlab ubi pipx npm`; up to 20). Before the step runs, the missing ones
  are installed with mise into the home (`~/.local/share/ruyix-tools`: no root, kept across restarts and newer images; Linux and
  macOS) and put first on the `PATH` and in the environment of the step's own processes — its commands and its agent (`RUYIX_TOOLS_PATH`;
  a line in the home's shell profiles keeps it first in the login shell a script step runs in, and the person's own terminals are left as
  they were). dsh's own `PATH` and environment are never changed, so nothing installed can shadow a command dsh runs itself (`git`). mise
  itself is fetched once — a pinned release, its SHA-256 checked against the one in the source. One version of a tool is in use at a
  time. What mise cannot install — a Docker engine, a system package, a name it does not know — stops the step (it fails the way
  its "on failure" says) with how a person puts it in place and the command to copy (`nookbox install <sandbox> <package>` in a
  sandbox); a failed install is not tried again for ten minutes. An agent can ask for one mid-run: `tools_ensure` — only an agent that may change files has it (write or full access, not a
  read-only step), and only for a name from mise's registry (`shellcheck`, `jq@1.7.1`): never an explicit backend (`npm:`, `pipx:`,
  `github:`, `ubi:`, `cargo:`, `go:`, `aqua:`, `http:` …), which only a person's `cli` list may name. Each tool put
  in place or missing is on the run (`run.tools`, a `tool` ledger entry, the report's "Command-line tools" section). Readiness shows
  each as here / installed on the first run / missing (with how); a tool a run's agent asked for and the step does not list is
  "asked for in a run", with "Add to this step" in the editor. `workflowEnsure` installs what can be installed.
- Verdict: `run.verdict.level` is any word the workflow chooses (`workflow.success` counts as success; unset: `done`).
  Only `failed` and `cancelled` mean something to the engine (a failed stop, a crash, a cancel).
- A step's `run(w)` returns `{ ok, note, ... }`: `ok: false` fails the step (the run goes on to its `final` step, unless
  `stop: true`: nothing after it runs); `goto: <earlier step>` runs that step and the ones after it again; `jump: <step>`
  skips ahead; `carryOn: true` keeps the step failed but carries on; `verdict` names the level of a failure.
- **A decision asked in a parallel lane** that sends the work back (`revise` / `check` from a step) is not a lane's failure:
  the block goes back **as a whole**. A target before the block: that step, and everything after it, runs again with every lane;
  a target inside the block (any lane): the block starts again, all its lanes. Each trip back is counted (`run.loops["<block>~decision"]`)
  and recorded in the steps' history; after 5 the run stops for a person. A decision asked on the main line goes back as before.
  Answering a decision while the run is `interrupted` (dsh restarted) only records the choice: the step asks the same question
  again when the run is resumed, finds the answered card and applies it there — it is not asked twice, nor lost.
- **Form fields** (`input`): `text`, `textarea`, `select`, `multiselect` (options: strings or `{ value, label }`),
  `checkbox`, `files` (the attachments; with several `files` fields an attachment names its `field`). Values land in
  `run.subject.fields`. Undeclared names, a wrong type, a select value that is not an option and a missing required
  field are refused before anything is stored.

### The step context `w`

`run` (getter: the latest run document), `workflow`, `pack`, `packSettings` (the pack's block of the run's settings),
`settings` (the run's snapshot), `signal` (cancel), `stage`, `store`, `services`, `toolNames`, `workspace` (settings'
`workspace`, else the run's folder), `outDir` (getter: `runs/<id>/out`, made on first use — what a step makes itself goes
here, not into `run.dir`, the agents' folder), `update(change | fn(run))`, `result()` (the step's `stage_result`), `evidence(entry)`
(a ledger entry in this step; `entry.full` — text or a Buffer — becomes an artifact, `entry.name` keeps a file's name),
`command(title, { code, stdout, stderr }, input)`, `agent(role, brief, { title, needResult, skills, web })` → `{ task, result, report }` (`skills`: refs added for this task, e.g. a style chosen per run; `web`: the task may search the web — a stage object may also say `web: true`)
(one task for the role's agent; it must call `stage_result`), `model(role, { system?, user, schema?, title?, temperature?,
maxTokens? })` → `{ text, data, usage: { calls, input, output, cost }, model }` (one call by a model role: the role's `text` and
`system` are the system prompt; given a JSON Schema the answer is an object that fits it — asked again, at most twice, with
what was wrong — else it throws; the ledger gets a `model` entry with the whole exchange, the tokens and the cost),
`exec(cmd, args, opts)` (never rejects), `script(ref)`,
`approval(spec)` (a card: `{ action, title, payload, note? }`), `writeReport()`, `sleep(ms)`, `lanes(keys)`.
`header(w, step)`, `subjectText(w)`, `outputsText(w)`, `claimsText(run, type)` (from `@ruyix/workbench/common`) build the brief.

### Approval actions: `actions.<name>(c)`

Run when a person approves a card whose `action` is that name (the card's `payload` is what the person edited);
the return value is stored as `approval.result`; a throw leaves the card `failed` (it can be approved again).
`c`: `approval`, `run`, `store`, `settings`, `services`, `workflow`, `pack`, `packSettings`, `exec`, `script`,
`command(title, res, input)`, `evidence(entry)` (stage `approval`), `approvals()`, `addApproval(spec)`, `update(change)`, `outDir`,
`currentSettings()` / `currentPackSettings()`. **`settings` and `packSettings` are the run's snapshot from the moment it started;
an action that reaches outside (an account, a connection, a dry-run switch, a folder) reads `currentPackSettings()` — the
person may have changed them since.** The engine saves the card as the action left it: an action may rewrite its own card's
payload (`store.put('approval', …)`) to use up a one-shot choice the person made on it.
`services.connectors()` is the connectors service (`client(id).request(path, { level: 'write' })`, `env(id, …)`), or null.

### Tools

Agents get, through dsh tool registration (dsh agents) or the MCP bridge (Claude Code / Codex, token per step):

| tool | |
|---|---|
| `wb_context` | the request, the run's folder, steps and their state, what each step handed back, claims, the ledger index |
| `evidence_get {seq}` | one entry in full (artifact text ≤ 20k) |
| `claim_add {type, text, evidence[]}` | type `finding \| decision \| risk \| source \| output`; must cite existing evidence |
| `decision_needed {question, why, options[2–4], recommended?, blocking?}` | a card for the person; `from` of a revise/check option is a step key of this workflow |
| `help_needed {question, tried, would_help?}` | asks the person for what only a person can give; `tried` cites this step's evidence (#n); the run waits after the step and it runs again with the answer; at most 3 times in a step (lib/human.js) |
| `file_save {name, content, encoding?, title?, mime?}` | text or base64 → an artifact + a ledger entry (`kind: 'file'`), returns its evidence number |
| `tools_ensure {tool}` | puts a command-line tool in place with mise (no root): `name` or `name@version` of mise's registry, only for an agent that may change files; one it cannot install comes back with how a person does (lib/toolbox.js) |
| `stage_result {result}` | the step's structured result (checked: a custom step wants `{ ok, summary, findings? }`; a pack step's `validate(result, c)` runs) |

The MCP bridge is an endpoint on a Unix socket of the workbench's own (a TCP port in a microVM box may refuse connections; before an agent starts, the engine asks `/tools` through the same way and stops the step, saying why, when it does not answer): one token per step, **valid until the step is over** (passed, failed, skipped or the run
cancelled — a token of a step that is over is refused, so an agent that lingers cannot write into a later step or the run; a
resumed step gets a new one). A request body is read as bytes and may be as large as `file_save`'s largest file as base64
(25 MB → about 34 MB); a larger one is read to its end and answered with HTTP 413 (`the request is over N MB`).

A pack adds `pack.tools` (`{ name, description, parameters, run(c, args) }`; names must be unique across the core and the
packs). A step of a pack's workflow gets the core eight and its pack's tools; a person's agent step gets what it lists in
`tools`. Tool context `c`: `run`, `store`, `workflow`, `stage`, `def`, `actor`, `signal`, `services`, `settings`, `pack`
(the tool's own pack), `packSettings`, `record(entry)`, `update(change)`, `approval(spec)`, `tools` (command-line tools).

## Packs

```js
// the pack's own plugin
export const inject = ['ruyixWorkbench']
export function apply(ctx) {
  ctx.inject(['ruyixWorkbench'], inner => inner.effect(() => inner.ruyixWorkbench.registerPack(pack), 'my pack: workbench'))
}
```

`registerPack(pack) → off()`; `pack` goes through `definePack` (fields and checks: `pack.js`): `id`, `name {en,zh}`,
`workflows`, `agents`, `tools`, `actions`, `settings`, `needs(s)`, `setup(s)`, `text`, `skills`, `ops(ctx)`.

- Workflows are `<id>.<workflow>`; the pack's `actions` are merged into each of them.
- `agents` are added to Agent Hub's pool once each (`agentHub.ensureAgents(defs)`: `{ id, name, runtime, model, effort,
  access, skills, notes }`); a person's edits and deletions stay.
- `needs(s)` goes to the connectors plugin (`connectors.require(pack.name.en, …)`); `s` is the pack's settings block.
- `settings` are the pack's defaults, kept at `settings.packs.<id>`; the settings page edits them with the core's.
- `ops(ctx)` → `{ <op>: fn(args) }` is served as `<id>.<op>` on the API; `ctx`: `{ store, engine, settings(), workbench, failWith }`.
- `beforeFileMutation({ run, kind, path, by, store })` is an optional synchronous guard for the engine's file editing, rewind, continue and resume APIs. `kind` is `edit`, `rewind` or `restart`; `path` is the original edit path (normalize it consistently with `lib/versions.js` when matching protected paths). Throw to refuse before files change, a running task stops, browsers close or stages/Studio status reset. A returned synchronous release function runs in `finally` after the operation, including failures, so a pack can hold its publication lock across version writes. The HTTP edit API always uses `by: 'person'`; trusted pack code can name itself for its own guarded save path.
- A pack with the same id replaces the one before. `off()` takes it out: its workflows start no new runs, its needs,
  skill packs and ops go; the runs it already has stay and can be read, continued, resumed and their cards approved
  (the engine keeps the workflows and tools those runs use in memory; after a dsh restart they wait for their pack).
- A tool name that is taken makes `registerPack` throw before anything changes.

## A run

```js
run = { id, template,                 // template: the workflow id asked for ('blank', 'notes.publish', a person's id)
  subject: { title, text, fields, evidence,                       // evidence: the ledger number of the request
             attachments: [{ name, artifact, sha256, size, mime, path, field?, evidence }] },   // path: a copy in the run's folder
  dir,                                // <home>/runs/<id>/work, made when the run starts; Agent Hub's job works there (the agents' folder)
  folder?,                            // a host folder the person named (a workflow with `folder`): the agents work there instead of in `dir`
  outDir,                             // <home>/runs/<id>/out: what the engine and the pack make themselves (not in `dir`)
  config,                             // the settings the run started with (a snapshot)
  status,                             // queued | running | waiting | done | failed | cancelled | interrupted
  waiting?, waitingFor?,              // 'decision' + the card's id
  stage,                              // the step going now
  stages: [{ key, owner, title?, status, attempt, startedAt, endedAt, note, round, result, resultBy, tasks[], history[], resume,
             agent?: { role, id, runtime, model, at },         // who works on it (set when its task is given)
             version?: { base, commit, made, files: [{ status, path, from? }], more?, big? } }],  // the folder before and after it
  versions?: { start },               // the folder's first version
  edits?: [{ path, version, by, at }], guidance?: [{ stage?, text, at, edit? }],
  verdict?: { level, reason?, stopped? },
  outputs: { <step>: … },             // what a person's own steps handed back
  claims: [{ id, type, text, evidence[], actor, stage, at }], decisions[], loops{},
  note?, tags[], workflowDef?, skills?, jobId, leadId, report?, reportSha256?, error?,
  createdAt, endedAt?, resumedAt?, interruptedBy?, interruptedAt?, autoResumes?, archivedAt? }
```

Step status: `pending → running → passed | failed | skipped`. Dropping back (`goto`, a decision, a failing step's
`onFail: { goto }`) puts what a step did into its `history`. A dsh restart marks going runs `interrupted`
(`interruptedBy: 'restart'`); they resume on their own once Agent Hub is up (`settings.autoResume`).
Approval documents: `{ id, runId, status: pending | running | done | failed | rejected | superseded, createdAt, action, title,
payload, note?, decidedAt, doneAt, result, error, reason, applied, supersededBy? }`. A new card for an action the run has an open
(`pending`) card for takes its place: the old one becomes `superseded` (the panel says "replaced by a newer card"; it cannot be
approved) — except a decision, of which a run has many; the same card asked again is the same card. Evidence entries: `{ run, seq, stage, kind, actor,
at, title, input, output, code, ok, artifact, sha256, prev, hash }` — `hash` seals the entry and the one before it;
`verify` re-reads every artifact too. Kinds the core writes: `snapshot`, `file`, `agent`, `model`, `gate`, `approval`, `command`,
`version` (going back, a person's edit, going on from a step). A step's `gate` entry names its version (`input.version`).

### A review (`lib/review.js`, docs/design/review-step.md)

Every `ask: 'review'` person step: it shows `show` (paths or `*` patterns in the folder; none: what the step before changed;
`review/<step>/note.md` first when `gather` had the agent write one), the person comments — `at`: a passage
(`{ quote, prefix, suffix }`), `{ lines }`, `{ field }`, an image's `{ box }`, a media `{ time }`, or the whole — and may edit a
file (`editFile`); then on its decision card (`editor: 'workbench.review'`, the page `src/review.jsx`): **Approve**, **Revise
with my notes** (`amend`: the agent of `revisedBy` — a step before it; none given: the nearest agent step; `false`: none —
changes the files now, answers every open comment `done`/`declined` in its `stage_result` `{ summary, replies }`, checked in the
same task; the next round starts at its version), **Ask for changes** (`back`, as before: the comments go to that step), **Stop**.
`rounds` (default 5, at most 20) revisions, then only approve, back or stop. State: `run.reviews[<step>] = { round, max, status:
person | gathering | revising | done, version, files, comments: [{ id, file, at, text, status, reply?, sentIn?, reopenedIn? }],
rounds: [{ n, version, choice, summary, by, after }], agent, step, past? }`. Ops `reviewOf`, `reviewSave` (a comment the agent
answered keeps its words: the person may only open it again); `GET /api/ruyix-workbench/work?run=&path=` streams an image,
video, audio or PDF of the folder (Range), nothing else. A pack: `reviewStep(w, s)` (or `personStep` with `ask: 'review'`),
`display: '<pack>.<editor>'` for its own view inside the page.

### Results and the viewer (`lib/results.js`, `src/viewer.jsx`, docs/design/results.md)

A `{ use: 'output', id, title, text?, show? }` step names the run's results (paths or `*` patterns; none: what the run
changed so far) and waits for nobody; without one, a run's results are what it changed since it began. The run page's
结果 tab opens them in the viewer (also the review's): Markdown, text with line numbers, images, PDF page by page
(pdf.js, `vendor/pdfjs`, served at `/api/ruyix-workbench/pdfjs/…`), web pages running in a sandboxed frame of no origin
(`pageOf` puts the folder files they use in as data: URLs), video and audio; any file downloads (`/work?…&download=1`).
Comments on results (`resultsSave`, a page's box `{ page, box }` among the anchors) go with the run going on again from
a step the person picks (`resultsRestart` → `engine.continueRun`, the open comments in that step's brief; they become
`sent`). A review's "ask for changes" goes back to the step picked on its page (`payload.from`, one of
`payload.review.backTo`), `back` only the one picked to begin with.

### The agents' messages (`lib/messages.js`, docs/design/agent-messages.md)

A workflow with `messages: true` (a person's definition, or a pack's workflow) gives every agent step `messages_post`,
`messages_read`, `messages_wait` and the skill `messages/agent-messages`; each run has a space, `runs/<id>/messages.db` (beside
the folder: no version), and an agent posts as its role at its step (`writer@draft`; a person's agent step: the step). Not the
ledger: no entry, no evidence. Op `runMessages` → `{ on, messages, members }`; the run page's 留言 tab, and a panel
in 过程's side, closed until opened.

### Versions (`lib/versions.js`)

The run's folder (`run.folder`, else `run.dir`) is kept as versions in a shadow Git repository, `runs/<id>/versions.git`, whose
work tree is the folder: the folder gets no `.git` of its own, and one that is a Git repository already keeps its own untouched
(Git never takes in a `.git`). A version when the run starts, before a step when something changed since the last one (a person,
a tool outside the steps: `outside`), and after every step — passed, failed, or stopped mid-way; a step that changed nothing makes
none. Each commit's last line is `ruyix:{ kind, step?, status?, … }` (kinds `start`, `step`, `outside`, `edit`, `rewind`, `review`): the page
words it. Left out: the folder's own `.gitignore`, `node_modules/` and the like, any file over 20 MB (listed as `big`); a folder
of more than 20 000 files gets no versions at all (said why). The person's own Git settings (hooks, signing) have no say.

- **Back to before a step** (`rewindRun`): the run stopped first when it is going (and its agents' tasks over); what changed
  outside the steps gets a version first; what has no version and is in the way — a file the folder's `.gitignore` hides, one
  too big, a folder with a Git of its own, under a path that becomes a file — is moved aside to `runs/<id>/kept/<when>/`
  (`kept`); then the folder as that step found it (`git read-tree -u --reset`); a commit `rewind`; the step and the ones after
  it run again (each one's last attempt in its `history`). Nothing leaves the history. A person's hand edits it went back over
  are not told to the steps any more (those before it still are). The preview (`rewindPreview`) changes nothing (a temporary
  index): it returns the folder's `tree`, and `rewindRun({ expect: { tree, target } })` refuses (`changedMeanwhile`) when the
  folder or the step's base changed since. Git work on one folder is serial across runs; another run going in the same folder
  refuses going back and edits (`folderBusy`). Nested repositories are left out and named (`nested`); a Git that fails turns
  the run's versions off, saying why. Paths: `.git` in any spelling and links out of the folder are refused.
- **A person's edit** (`editFile`): of the folder's copy they opened (`fileAt({ commit: 'WORK' })` gives it and its `blob`;
  changed meanwhile → `changedMeanwhile`); what was pending gets an `outside` version first, then that file alone is the edit;
  never through a link out of the folder, not while a step works in the folder (`runBusy`; a run waiting for the person is fine).
  It is a version of its own, and the steps that run after it are told (their brief) to build on it.
- **A review's rounds** (`review`): a review step (below) keeps a version where each round of the agent's changes ends, so
  two rounds compare.
- **On from a step** (`continueRun`): the folder as it is, a note for that step if given (its brief), the step and those after it
  run again.

## HTTP API

`POST /api/ruyix-workbench` with `{ op, ...args }` → JSON. An error is HTTP 500 `{ error, code, params }`; an unknown op, 400.
Error codes: `noRun`, `badWorkflow`, `badInput` (`params.errors`), `noHub`, `noWorkflow`, `notResumable`, `noStage`,
`noApproval`, `approvalDone`, `noAction`, `archiveActive`, `workflowInvalid`, `badStep`, `noAgent`, `noEvidence`,
`workflowNotReady` (`params.what`), `noConnection`, `needInput` / `badAnswer` (a person step's answer), and for versions `noVersion`,
`noVersions`, `noFile`, `badPath`, `changedMeanwhile`, `runBusy`, `tooBig`, `stillRunning`, and for tasks `noTask`,
`taskBusy`, `taskArchived`, `badSchedule` (`params.errors`).

| op | args | returns |
|---|---|---|
| `sync` | `since` (a revision, 0 for all) | `{ rev, reset?, docs: [run \| approval \| task documents changed after `since`] }` — each step's `result` is `true` (read it with `run`) |
| `run` | `id`, `after?` | `{ run?, evidence: [entries with seq > after], active }` (`run` only when `after` is absent) |
| `startRun` | `workflow`, `title?`, `text?`, `attachments?: [{ name, base64, mime?, field? }]`, `fields?`, `note?`, `tags?` | `{ run }` — a one-off task of its own comes with it (`run.taskId`) |
| `taskCreate` | `workflow`, `title?`, `text?`, `fields?`, `note?`, `tags?`, `attachments?` (once only), `schedule? = { kind: 'once' }` (`daily` `{ at: 'HH:MM', days?: [0–6] }`, `every` `{ minutes ≥ 15 }`, `cron` `{ expr }`), `tz?`, `catchUp? = true`, `carry? = true`, `runNow?` | `{ task, run? }` — once: it runs now; scheduled: its request is checked now and it runs when due |
| `taskUpdate` | `id`, `title?`, `text?`, `fields?`, `note?`, `schedule?`, `tz?`, `enabled?`, `catchUp?`, `carry?` | `{ task }` |
| `taskRunNow` | `id` | `{ run }` — not while a run of it goes (`taskBusy`) |
| `taskArchive` | `id`, `archived? = true` | `{ task }` — an archived task does not run; its runs stay |
| `startRuns` | `runs: [{ workflow, title?, text?, fields?, note?, tags? }]` (1–50) | `{ runs: [{ run } \| { error, code }] }` — a batch; one that cannot start leaves the others going |
| `stopRun` | `id` | `{ run }` |
| `resumeRun` | `id`, `from?` (a step key; a finished run too) | `{ run, from }` |
| `archiveRun` | `id`, `archived? = true` | `{ run }` |
| `approve` | `id`, `payload?` (merged over the card's; what the card is — `options`, `stage`, `kind`, `by`, `person`, `wait`, `deadline` … — stays) | `{ approval }` — runs the action; a failing action: `approval.status 'failed'`, `error`. A person step's `help` card takes `{ input, answer? }` (an input step's empty answer is refused: `needInput`); a step that asked on its own also takes `answer: 'retry'` (with `input`) |
| `askHelp` | `id` (a step's ask card), `text` | `{ approval }` — the question is on the card's `chat`; the step's agent answers while the run waits |
| `versions` | `id` | `{ on, off, commits: [{ commit, at, parent, subject, mark }] }` — oldest first |
| `versionChanges` | `id`, `commit` | `{ files: [{ status, path, from?, added, removed }] }` |
| `versionFiles` | `id`, `commit? = 'HEAD'` | `{ files: [{ path, size }] }` |
| `fileHistory` | `id`, `path` | `{ history: [{ commit, at, subject, mark, status, path }] }` — newest first, across renames |
| `fileAt` | `id`, `commit? = 'HEAD'`, `path` | `{ blob, size, text \| image \| binary, cut? }` |
| `fileDiff` | `id`, `from?`, `to`, `path?` | `{ diff }` — unified; no `from`: what `to` changed |
| `rewindPreview` | `id`, `from` (a step) | `{ from, target, head, files: [{ path, action: remove \| restore \| revert }] }` |
| `rewindRun` | `id`, `from` | `{ run, from }` |
| `continueRun` | `id`, `from`, `note?` | `{ run, from }` |
| `editPreview` | `id`, `path`, `content` | `{ diff, blob, added, removed }` |
| `editFile` | `id`, `path`, `content` (text) \| `{ base64 }`, `blob` (the copy changed; `null`: a new file) | the version `{ commit, made, files }` |
| `reject` | `id`, `reason?` | `{ approval }` |
| `verify` | `id` | `{ ok: true, head, count }` or `{ ok: false, seq, reason, count }` |
| `report` | `id` | `{ markdown, sha256 }` (an evidence number is written plain, `#12` — the panel links it; the report written by the closing step shows that step as passed and the run as it is about to settle) |
| `artifact` | `id`, `seq` | `{ evidence, content }`; an image: `content: ''` + `image` (a data URL); a binary file: `binary: true` (a video: use the file route below) |
| `metrics` | | `{ all, byTemplate: { <template>: group }, recent: [...] }`, group = `{ runs, finished, verdicts, successRate, avgMinutes, avgTokens, avgCost }` |
| `settings` | | `{ settings, revision, defaults, file, hub, packs, ai: { agent, model }, agents[], stepAgents[] (agent or model steps, by kind), workflows{}, optionalStages[], connections, models (dsh's) }` |
| `saveSettings` | `settings`, `revision?` (from `settings` / `workflows`) | `{ settings, revision }`; a stale revision is refused with `settingsChanged`. The UI always supplies it; callers omitting it retain replacement semantics. |
| `models` | | `{ models: [{ id: 'provider/model', label }] }` |
| `packs` | | `{ packs: [{ id, name, workflows: [{ id, title, description, noun, success, input[], insertFrom, pack }], actions[] }] }` |
| `workflows` | | `{ builtIn: [{ id, title, …, steps (outline), library, ready }], mine: [definition + status + errors + ready], generic, agents, defaultAgent, connectors, connectorTypes, tools, skills, scripts, models (dsh's), defaultModel, picks, settingsRevision }` — `ready: { missing, installable, soft, what }` |
| `workflowReadiness` | `id` (a person's or a built-in one) or `definition` | `{ steps: [{ id, title, use, items: [{ kind: agent \| skill \| connector \| model \| script, ref, status, … }] }], missing, installable, soft, ready, what, connections }` — status `ok`, `missing` / `unbound` (stops a run), `fetch` (installed when it starts), `noFallback` / `warn` (soft) |
| `workflowEnsure` | `id` or `definition` | `{ fetched, failed, readiness }` — installs its pinned skill packs here |
| `bindings` | | `{ bindings, connections }` |
| `bindingSet` | `key` (a need's type, or `type:name`), `connection` (none: unbound), `workflow?` (that workflow's own) | `{ bindings }` |
| `aiWork` | `hours? = 24` | the AI work done here (`lib/aiwork.js`): `{ window, available, totals, timeline, by_agent, by_model, by_source, helper_kinds, steps, workflows, failures, tasks }` |
| `workflowValidate` | `definition` | `{ definition, errors: [{ step?, field?, message }] }` |
| `workflowSave` | `definition`, `enable?`, `create?` (reject an existing id), `expect?` (revision from the workflow list), `by? = 'person' \| 'assistant'`, `origin?` | `{ workflow, errors }` (the assistant's save is always a draft) |
| `workflowStatus` | `id`, `status: 'enabled' \| 'draft'`, `expect?` | `{ workflow }` |
| `workflowRemove` | `id` | `{}` |
| `translate` | `texts[]`, `lang: 'zh' \| 'en'` | `{ texts, model }` |
| `translateReport` | `id`, `lang` | `{ markdown, model }` |
| `chat` | `before?`, `after?`, `limit? = 50` (≤ 200) | the standing conversation's record, oldest first: the newest page, the one before entry `before`, or what came `after` → `{ items, more, running, model, agent, tasks }` (below; `tasks`: the background tasks, newest first, `{ id, title, status, agent, result, created, updated }`) |
| `chatSend` | `text`, `lang?` | `{ sessionId }` (dsh) or `{ agent }` (a pool agent) — `emptyMessage`, `chatBusy`, `noHub` |
| `chatStop` | | `{}` |
| `chatTopic` | | `{ n }` — a new topic: a line on record; the next message starts afresh (`chatBusy` while it answers) |
| `chatSearch` | `q`, `limit? = 30` | `{ items }`: entries whose words mention `q` (a message, a card's title or request, a workflow, a change), newest first |
| `chatDraftDone` | `n`, `status: 'started' \| 'dismissed'`, `run?` (started: the run) | `{ item }` — what became of a run card (`noCard`, `noRun`) |
| `taskStop` | `id` | `{ task }` — a background task called off: one that waits is never started, a running one is stopped (`noTask`) |
| `memories` | `q?`, `limit? = 200` | `{ items }`: what the conversations kept (`{ id, kind: preference \| fact \| decision, text, source, by: auto \| assistant \| person, pinned, created, used, uses }`) — the ones mentioning `q`, else all, pinned first |
| `memorySave` | `text`, `kind?`, `pinned?` (new) or `id` + any of them (change, pin) | `{ item }` — one line; never a credential (`memorySecret`), `noMemory`, `badInput` |
| `memoryDelete` | `id` | `{}` (`noMemory`) |
| `chatExport` | `format? = 'md'` (`'jsonl'`: every thread, summary and memory) | `{ name, text }` — the standing conversation as Markdown |
| `chatMaintain` | | `{ swept }` — the keeping now (it runs every ten minutes and at the start): once a day the entries past `chat.keepDays` keep their words and lose their tool calls and a board's rows (`null`: not due) |
| `chatAgents` | | `{ agents: [{ id, name, runtime, model }], agent }`: the pool's Claude Code and Codex agents it can run on |
| `setChatAgent` | `agent` (null: dsh) | `{ agent }` (`noChatAgent`, `chatBusy`) |
| `setChatModel` | `model` (`provider/model`) | `{}` — the dsh model it runs on, kept for its next sessions |
| `<packId>.<op>` | the pack's | the pack's |

Large attachments travel as base64 in one request: the limits are 20 files, 25 MB each, and what dsh accepts as a body.

`GET /api/ruyix-workbench/file?run=<id>&seq=<n>[&download=1]` streams the artifact file of ledger entry `n` of a run — for
`<img>`, `<video>` and `<audio>` (a base64 data URL does not suit a video). The type comes from the file's name; `Range:
bytes=a-b | a- | -n` is answered with 206 (and 416 when it starts past the end), so a video can be scrubbed. Only a file a ledger
entry names is served, and only from inside that run's folder (a missing run, entry or file, or a path that leaves the folder: 404;
no `run` / `seq` or a bad number: 400). Every answer carries `Content-Security-Policy: sandbox` and `nosniff`, and a page type
(HTML, SVG) is sent as plain text to a browser that opens it on its own.

## Service `ruyixWorkbench`

For other plugins (`ctx.inject(['ruyixWorkbench'], …)`):

| method | |
|---|---|
| `registerPack(pack) → off()` | see Packs |
| `packs()` | the registered (checked) packs |
| `startRun(args)` / `stopRun(id)` / `resumeRun(id, { from?, withNewSteps? })` | as the ops; `startRun` → the run; `withNewSteps` adds the steps the workflow gained since the run started (those before `from` as skipped) |
| `run(id)` / `runs()` | a run document / all of them |
| `report(id)` | the report Markdown |
| `approvals(runId)` | the run's cards |
| `settings()` / `packSettings(id)` | the settings (with `assistantModel`, `translateModel`) / one pack's block |
| `revision()` / `evidence(runId, after?)` / `readArtifact(rel)` | the change counter / entries / an artifact as a Buffer |
| `workflows()` | `[{ id, title, description, pack, noun, success, input, insertFrom }]` of the workflows a run may start on |
| `note(runId, entry)` | add a ledger entry from outside (stage `note`) and rewrite the report |
| `aiWork({ hours })` | the AI work done here (as the op) |
| `readiness(id, definition?)` | what a workflow needs and how it stands here (as `workflowReadiness`) |
| `callModel({ model, system?, user, schema?, … })` | one model call, no tools (logged as the workbench's own, kind `pack`) (a model step's call: `<connection>:<model>` or `dsh:<provider>/<model>`; with a schema, an object checked against it) → `{ text, data?, usage, model }` — for a pack's own ops |
| `connectors()` | the connectors service when its plugin is on (`driveList`, `driveFiles`, `driveUpload`, `driveDownload`, `share`, …), else null — for a pack's own ops |
| `busy()` / `overview()` / `setup()` | what a restart would cut short / the home page's tiles / its setup steps |

It also registers with the shell: `ruyixShell.part({ id: 'workbench', name, panel: 'ruyix-workbench', order: 20, busy, setup, overview,
workbench: { aiWork } })` — the box plugin finds the AI work through `ruyixShell.parts().find(p => p.workbench?.aiWork)`.
`overview` is one section `workbench-now` with tiles `approvals`, `running`, `success` (the last 20 runs); a tile opens with
`{ event: 'ruyix-workbench:open', detail: { view, scope? } }`. `setup` is the agents step, each pack's connections step and
the steps the packs add (`pack.setup`).

## For the panels

- **Panel ids**: the runs panel is `ruyix-workbench` (with its metrics), the inbox (approvals and notifications) `ruyix-workbench-inbox`,
  the workflows `ruyix-workbench-flow`, the Chat page `ruyix-workbench-chat` — sidebar order 11 / 12 / 13 / 14, the shell's Workbench group. The settings are a tab of the
  shell's Settings page (slot `ruyix.settings.tab`, tab id `ruyix-workbench-settings`).
- **The inbox as one place** (`src/inbox.js`): other plugins join it through three slots — a slot entry keeps only `{ id, order,
  label() }`, so a plugin's stores live in `window.__ruyixInbox[id]`: `ruyix.inbox.tab` (a tab of its own before the
  notifications, its content rendered from the slot; `{ count }`: a store of how many are new there), `ruyix.inbox.needs` (what
  waits on the person elsewhere, listed above the approvals and counted with them) and `ruyix.inbox.system` (the System tab:
  what this machine needs from the person). `items` is an external store (`subscribe` / `getSnapshot`) of rows `{ key, icon?,
  kind?, tone, title, detail?, affects?, since?, actions?: [{ label, primary?, run() }], open?() }` — tones `danger` / `warning` /
  `info` (or `red` / `amber` / `blue`). The inbox's badge counts the approvals, what waits elsewhere and what blocks work now or
  within days (danger and warning rows); else, in blue, what is new (notifications, other tabs' counts).
- **The shell's way in**: the home page finds the inbox through `window.__ruyixWorkbenches` (see `core/shell/src/main.jsx`): the
  client registers `window.__ruyixWorkbenches['ruyix-workbench'] = { event: 'ruyix-workbench:open', inbox: 'ruyix-workbench-inbox' }`.
- **Opening a view**: `window.dispatchEvent(new CustomEvent('ruyix-workbench:open', { detail }))`; `detail.view` is `approvals`,
  `notices`, `system`, `inbox:<a plugin's tab id>`, `runs`, `flow`, `settings`, `metrics`, `chat` or `new` (the new-run form); `detail.scope` (`active`, `all`, `archived`) is the run list's filter; `detail.run`
  (or `id`) opens one run, on `detail.tab` (`overview`, `pipeline`, `files`, `evidence`, `report`, `approvals`) — the assistant's `workbench_show`
  uses the same words.
- **A run's page** (`src/runs.jsx`): the process tab (`src/process.jsx`, tab id `pipeline`) shows the flow of steps (where the run
  is, what is done or failed, ↺ for a step run again), what is going on right now (the step at work, who works on it, its last
  ledger entry, or that it waits for the person), each step's own story (its ledger entries as they come in, the files it changed,
  its result, its earlier rounds) with the ways to steer from it — back to before it, on from it, see and edit its result — and a
  time chart (when each step ran, how long it waited for the person). The files tab (`src/versions.jsx`) lists the versions and
  what each changed (`src/diff.jsx`), a file's own versions side by side, and the edit that makes a new one.
- **Work in progress, wherever the person is** (`src/work.jsx`): the runs going now — each a runway: a stretch of track
  per step (done, at work with a current running through it, waiting for the person in amber, failed, to come; a
  parallel block one stretch with its lanes side by side), a runner carrying the icon of the agent at work that moves on
  while the step works (easing towards the end of its stretch, never claiming the step done), sparks at each thing the
  agent does and stops amber at the person's turn; a run just done crosses the line; under it, the step at work, who
  works on it and how long, or what it waits for the person for — and what just finished, in the shell's top bar
  (`window.__ruyixTray`: a ring while something goes, an amber hand and a count when something waits for the person; its
  menu lists them). A click opens the run on its process (or its cards, when it waits). Drawn in the shell's styles.
  (The desk's 「正在做」 strip — the shell's, docs/design/agent-work.md §2 — shows each piece of work; the desktop widget
  `workbench:work` that did the same is gone.)
- **Who is at work right now** (`src/activity.js`): one small snapshot for whatever draws it — the desktop's lights
  (the shell's `src/desktop/agents.jsx`) and the runways' sparks: `window.__ruyixActivity` `{ agents, links, runs }` and
  the event `ruyix:activity`, from the workbench's own store (the poll the page makes anyway) and the newest ledger
  entries of the runs going (each a pulse of its step's agent; a look every few seconds while runs go, none while the
  page is hidden). Its shape is in the file; `activity-check.mjs` checks it.
- **Tasks and runs** (`lib/tasks.js`, `src/tasks.jsx`; design docs/design/tasks.md): a task is what the person wants
  done — a workflow, its request and when it runs: once, or again and again; a run is one time it ran (`run.taskId`). A
  run started without a task (the assistant, a pack, a home from before tasks) gets a one-off task of its own, so the
  Runs page lists tasks: the newest run of the one picked is its page, the task above it — when it runs and next, what
  happened at its last times (skipped while the last run still went, missed while the machine was off, could not
  start), its runs one after another, run now / pause / change the time / make a one-off repeat / archive. A
  scheduled task's request is checked when it is made; when it is due and its last run still goes, that time is
  skipped (said on the task), never stacked; a time missed while the machine was off runs once when it is back
  (`catchUp`), or waits for the next; Agent Hub not up yet: tried again for half an hour, then said on the task.
  `carry`: each run gets the last finished run's files in `previous/` (its own files: no attachments, nothing hidden,
  no links, 2 MB each, 20 MB and 300 files at most; a run in a folder the person named finds it as it was left) and its
  brief says to write only what is new. Times are the person's (the browser's time zone, sent with the task; one made
  by the assistant takes the person's last). The new-task form's "when to run" and the time dialog share the fields
  (`WhenFields`): now once, every day, weekdays, some weekdays, every few hours, cron — with what it means (next
  10月18日 08:00, in 20h). The assistant lists tasks (`workbench_tasks`) and, when the person says so outright, makes
  a scheduled one, pauses or retimes one, runs one now. The work-in-progress list shows the scheduled tasks not
  running with when they run next (a line that fills as the time comes). `tasks-check.mjs` checks it.
- **On the shell's 「任务」 page** (docs/design/work-in-one-place.md, 2026-10-19): the 运行 and 记录 pages are folded into
  it (`window.__ruyixNav[id].into`: off the sidebar, the dock and the pages an agent opens; their opens land there, a run
  on its task). The workbench's parts of it: a workflow's task — or a request that started runs — shows its bar and its
  runs (steps, evidence, report, approvals) in the task's detail (`ruyix.tasks.part`); the 「定时」 and 「指标」 tabs
  (`ruyix.tasks.tab`; 指标 had no other place once the runs page was folded); the new-task form in the page's sheet
  (`ruyix.tasks.new`, its preset as `ruyix-workbench:open { view: 'new' }` takes it). Every task says what it used
  (`usage { tokens, cost, ms }`: its runs' agents and time, a conversation's turns, what its source counted); the list
  takes `agent`, `from`/`to` and says who did them (`agents [{ id, name, n }]`); `taskGet { run }` finds a run's task.
  The workbench's own opens of a run, a task, a new one, 记录 or 指标 go there too. The inbox stays a page of its own.
- **The conversation start to finish** (same design): a task its source said goes on (`update(id, { step })` — App
  Center's install, a session's work) is left working when the turn ends, with a live task card on the question; when
  a conversation's task moves on after its turn (done, did not work, stopped, ready to confirm — with a 好了 card —,
  waiting), a line says so on its question in the person's language (the source's `result`, else one of its own), the
  question comes back on the desk, the strip says it, and the main agent hears it with the next message. The person's
  own 好了 / 再改 and the task going again say nothing.
- **When a task runs** (`lib/schedule.js`): once, every day at a time (or on chosen weekdays), every N minutes (15 at
  least), or a cron line; in the person's time zone, daylight saving included (08:00 stays 08:00 on both sides; a time
  the clocks skip is the first minute after); `dueSince` — the box was off when it was due: one run makes up for it,
  not one per miss; `describe` says it in words (每天 08:00 · 工作日 09:30 · 每 6 小时). `schedule-check.mjs` checks it.
- **How a workflow works, before it starts** (`src/wfmap.jsx`, in the new-run form): its steps in order and who does each
  (an agent of the pool, a model, the person, the system), where it waits for the person, what may leave the machine
  (a step marked `sends`: its cards, once approved) and what uses the web (`web`) — from the workflow's outline.
- **A run's browsers** (`lib/browser.js`, `src/browser.jsx`): a step (`w.browser`) or an approved card (`c.browser`) opens a
  headless Chromium (`open({ title, url, cookies, watch })` → `{ id, page }`; `step(id, text)` says what it is doing;
  `shot(id, title)` keeps a moment in the ledger; `render({ html, width, height, scale })` → a PNG). Its screen is live on
  the run's process and on the card whose result names it (`result.browser`): the person clicks, scrolls and types there
  (a line for an input method and pastes), and does the last click themselves. Three at a time; an hour untouched closes
  one. Ops: `browsers`, `browserState`, `browserInput`, `browserClose`.
- **The assistant's run-change cards**: `workbench_run_rewind` / `workbench_run_edit` / `workbench_run_continue` only record a card
  (`kind: 'runop'`); the chat shows what it would do (the files that change back, the difference) and the person applies it there
  (`chatRunOpDone` keeps what became of it). The assistant reads versions with `workbench_run_versions` / `workbench_run_file`.
- **Pack extensions** (a pack's own `client.js`):
  ```js
  window.__ruyixWorkbenchExt ??= {}
  window.__ruyixWorkbenchExt.<packId> = {
    locale: { zh: {…}, en: {…} },               // words; they win over the core's (stage.<key>, workflow.<id>, workflow.<id>.desc, key.<field>, kind.<kind>…)
    approvals: { <action>: { icon, Body } },    // the review card of an action; without one: the generic card
    decisionEditors: { <name>: Editor },        // what a decision card shows to change before choosing (payload.editor: '<packId>.<name>')
    runBoxes: [Component],                      // status blocks under a run's header (the pack's runs only), props { run, approvals }
    settings: { <packId>: Component },          // the pack's form in the settings tab; without one: its settings.packs.<id> as JSON
    css: '…',
  }
  window.dispatchEvent(new Event('ruyix-workbench-ext'))   // the panels pick the change up
  ```
  A decision whose payload names an `editor` shows that pack's `Editor` under its question: props `{ a, run, open, busy, choice,
  option (the chosen one), lang, onPayload(fields), onBlocked(yes), call(op, args) }`; what it hands `onPayload` goes with the choice
  (`{ choice, comment?, …fields }`, merged into the card's payload), so the step after the decision — or the step a `revise` sends the
  run back to — reads the person's changes from the card. The engine itself knows nothing of them.
  `Body` gets `{ a, run, open, busy, onPayload(next), onBlocked(yes), call(op, args) }` (also under the names `approval`, `payload`,
  `readOnly`, `lang`): `a` the card, `open` whether it can still be decided, `onPayload` what to send with the approval (merged over the
  card's payload by the server), `onBlocked(true)` holds the approve button back, `call('x')` runs the pack's own op `<packId>.x`
  (a name with a dot is sent as it is). A settings component gets `{ value, defaults, onChange(next), lang, settings, call, toast }`
  — the settings tab keeps one draft and one Save. The pack of a run is the part of its workflow's id before the dot.
  The generic card shows the title, `note`, every field of the `payload` (a string in a text box, a boolean a tick, a number a
  number box, an object or a list as JSON), approve / reject (a failed action can be approved again). A `decision` card lists its options.
- **A run's products**: the files in its ledger (kind `file`: what `file_save` stored; the request's attachments are shown with the
  request) are in the overview's gallery: an image as it is, a video with a player, audio with its player, text and Markdown unfold.
  What a step handed back (`run.outputs`, `stage.result`) is shown under the step: its `summary` as Markdown, the rest folded as JSON.
- **The standing conversation** (`lib/assistant.js`, `src/chat.jsx`, `src/chat-state.js`): one thread with the person, kept as the
  `main` thread of `conversations.db` (`lib/conversations.js`; a home from before had it in `workbench.db`'s `chat` table: its rows
  are taken over once at start, numbers, keys and times as they were, and again if an older archive is imported over the home) —
  entries `{ n, at, kind, … }`: `user`, `text` (an answer), `tool` (`name`, `target`: a step, shown folded),
  `error`, `ui` (`workbench_show`: `args { view?, run?, tab? }`), `genui` (`workbench_ui`: a board, drawn by `@ruyix/board`'s
  `Board` through `inline.js`; one that does not check is not drawn, and the assistant was told why), `draft` (`workbench_run_draft`:
  a run card `args { workflow, title, text?, fields?, note? }`, `outcome { status: started | dismissed, run }` once the person chose),
  `workflow` (`workbench_workflow_save`: `args { id, title, steps }`, a card that opens it in the editor), `run` (a run the assistant
  started, its state followed), `change` (`ruyix_change_propose`: the shell's card applies it, only the person), `topic`. A dsh
  session's projection (`ruyixWorkbenchChat`, `{ on, items, total }`) is copied in as it comes. **A session lasts while the talk goes
  on**: after `chat.idleHours` (default 6) without a message — or `ROLL` (200) items — the next message starts another, and that one
  is told, after the brief and what is kept (Memory, below), the summary of what came before (`summaries`, made meanwhile by the
  ten-minute keeping once the conversation has been quiet that long, or when a new topic begins — never in the way of a message) and
  what was said after it, the cards still open among them; with no summary yet (no model, or it did not come yet) the last exchanges
  take its place (`seedOf`, back to the last topic). A new topic starts afresh: only the cards still open are carried. So the
  assistant's context stays small however long the conversation has grown, and `workbench_chat_history` reaches the rest. On a pool
  agent (Claude Code, Codex: Agent Hub's `chatTurn`) its CLI session goes on from turn to turn and gets the same tools over the MCP
  bridge (a token per turn). The assistant asks nothing of the person's approvals: it says what waits.
- **Background tasks**: a longer job — an analysis across several runs, a long investigation, read only — the assistant hands over with
  `workbench_background_task` { title, task } (the task in full: it does not see the conversation) and goes on talking. The task is a thread
  of its own (`kind: task`, `parent: main`; its steps are its entries) and one turn on a Claude Code / Codex agent of the pool — the
  conversation's own agent when that is one, else the first Claude Code, else Codex (`hub.chatTurn`, which is read only) — with the
  conversation's tools over the MCP bridge **minus everything that acts**: runs, report, evidence, metrics, setup, workflows, history and
  memory search; it starts, stops, writes, draws and spawns nothing (the bridge's token carries its scope). At most `chat.maxTasks`
  (3) run at once, the rest wait their turn, oldest first. In the conversation: a `task` entry (a card with the state, a Stop button
  while it runs or waits) where it started, and when it ends — `done`, `failed` (why), `cancelled` — a second `task` entry
  (`ended: true`, `result`: its conclusion, Markdown) at the end of the conversation; the assistant hears it with the person's next
  message (`[Since your last turn: …]` before the question; the record keeps the question only). A task over `agentTimeoutMinutes` is
  stopped; one a restart cut short is over, `failed`. No Claude Code or Codex agent in the pool: the tool says so and the assistant does
  the work itself or tells the person. The shell's working dot is lit while a task goes; its conclusion counts as unread.
- **Memory** (`memories` in `conversations.db`): preferences, facts and decisions kept from what was said, shared by every conversation
  and every session, shown to the person in the drawer of the chat sheet and the Chat page ("Memory": add, change, pin, delete). Kept
  by the assistant (`workbench_memory_save`, found again with `workbench_memory_search`), by the person, and automatically: a
  conversation gone quiet for `chat.idleHours` (and one that is given a new topic) is condensed by a model call (`lib/assistant.js`
  `summarize`, on the conversation's model, else Agent Hub's default agent's) into a summary (`summaries`) and at most five memories.
  Each new session is told them (`memoryBrief`: the pinned first, then the lately used, within 2000 characters). **Never a
  credential:** a text that reads as one (a password, key or token, an Authorization header, a private key block, a URL with a
  password — `isSecret` in `lib/conversations.js`) is refused by the tool, the drawer and `memoryAdd`, dropped from what a summary
  proposes, and taken out of the summary itself (`redact`). A memory is one line (it is told inside the brief).
- **The shell's chat sheet**: the client registers into the shell's slot `ruyix.chat` (scope `root`) a component `({ onClose, lang })`
  that fills its box (its own scroll, the input at the bottom, no ground of its own). The shell opens the sheet on the window event
  `ruyix:chat` (`{ open? }`); its palette asks with `ruyix:chat-ask` `{ text }`, which the client sends as a new message. The client
  keeps `window.__ruyixChat = { busy, unread }` and sends `ruyix:chat-state` whenever either changes (unread: what the assistant
  said or made since this browser last showed it). A `workbench_show` said while the sheet is open opens that page: `ruyix:open`
  `{ panel }` (the shell), then `ruyix-workbench:open`. The Chat page (`ruyix-workbench-chat`, sidebar order 14) shows the same
  record for long reading and search. A run card's "change it" opens the new-run form filled in (`ruyix-workbench:open`
  `{ view: 'new', workflow, title, text, fields, note, card }`); a run started there settles the card.
- **Sync**: poll `sync` with the last `rev`; a `reset` means start over. Evidence is read with `run { id, after }`.
- **Build**: `node build.mjs` bundles `src/main.jsx` into `client.js` (React and dsh's Markdown component stay external, as in
  `core/plugins/agent-hub`); `package.json` has `exports["./client"]` and the `dsh.client` block.
- Not served: mermaid's browser bundle — a diagram in a report shows as its code.

## Settings

`settings.json` keeps what differs from the defaults: `workspace` (the folder script steps with `cwd: 'workspace'` run in;
empty: the run's folder), `steps` (workflow → step → `{ agent, fallback, skills }`, or `{ model }` for a model step), `model`
(the model a model step uses when neither it nor its role names one; empty by default), `stages` (optional steps turned off:
`{ <key>: false }`), `agentTimeoutMinutes` (60; one grace turn of up to 10 minutes after it), `autoResume`
(`{ enabled, maxAgeHours, maxPerRun }`), `chat` (`{ idleHours: 6, keepDays: 90, maxTasks: 3 }`: the standing conversation — hours of quiet after which the next message
starts a new session told the summary, days an entry keeps more than its words, how many background tasks run at once), `packs.<id>` (a pack's block). The conversation (until the person picks a model or a pool
agent for it) and translation run on Agent Hub's default agent's model.

## Checks

`node check.mjs` — no domain words in the core (code, panels, README, skill); an end-to-end run on a fake Agent Hub (intake →
agent step → sign-off → approved action → report; cancel, failure and go-back, resume, branch, parallel, a person's workflow on
`blank` and on a pack's, person steps (review, input, decide, do, the reminder), readiness and bindings, the AI work, attachments,
forms, the file route with Range, packs coming and going, a restart; the standing conversation: its record, tools, cards, a session while
the talk goes on and the next after a quiet spell with its summary, a new topic, search, memories (never a credential), background tasks
(three at a time, their conclusions, called off, cut short), the history tool, a home from before taken over, `workbench_ui`'s check, a pool agent's turns over the MCP bridge). `conversations-check.mjs` (run by `check.mjs`) — the
record on its own: entries once per key, paging, search (FTS5, and LIKE for a word of one or two characters), threads, summaries,
memories (a credential is never one), the kept days, the export, the move out of the old `chat` table. `node config-check.mjs` — settings,
workflow definitions, the form, the ledger, the inbox's counting (`src/inbox.js`) and how the conversation is doing for the shell (`src/chat-state.js`: busy, unread, the palette's question). `node versions-check.mjs` — a run's versions: a version per step (none for a step that changed nothing), a file's
history and differences, going back without losing what came after, a person's edit that refuses a stale copy or a link out of the
folder, big files left out, a person's folder that is a Git repository left untouched, no Git at all; then through the engine: an
edit and going on from a step, going back while a step works (it is stopped, its files kept as a version). None needs a network or a real dsh.

© 2026 Ethan H.B. Zhou

Task, output and record lists return `cursor: { at, id }`. Pass that object as `before` for the next page so items with the same timestamp are retained. A numeric `before` remains supported for older callers. Chat cards start through `chatDraftStart` and apply run changes through `chatRunOpApply`; each operation owns the card before mutating the run. `chat` accepts the loaded card numbers as `cards` and returns their current versions in `changed`.

Comment views pass the returned revision to `reviewSave` and `resultsSave`; stale saves are refused so another open page cannot overwrite unsent comments. The page keeps unsaved text visible, and a decision waits for a successful save. Workflow replacement, status changes and removal keep the previous definition in `workflows/.history/` with unique file names.

Workflow list and save replies include an opaque `revision`. Editors pass it as `expect` when saving, enabling or removing that definition; a stale action is refused before changing it. Opening a saved workflow from the assistant refreshes its definition and remounts the editor for that revision, with the usual unsaved-change confirmation.
