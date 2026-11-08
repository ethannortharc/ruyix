---
name: workflow-create
description: Create or change a workbench workflow from what a person describes — built on a built-in workflow (blank, or a domain pack's), with agent, model, script, approval, person, branch and parallel steps of its own, or a script step (`use: flow`) whose code drives agents, commands and people with every step kept so a stopped run goes on; saved as a draft the person reviews and enables.
---

# Create a workbench workflow

A workflow is the list of steps a workbench run goes through. The built-in ones are code: `blank` (the core's: the
request goes in, the report comes out) and the workflows domain packs bring (`<pack>.<workflow>`), whose steps hold the
gates that make a run trustworthy. A person's workflow is **built on one of them** (its `base`) and changes it in three
ways:

1. **Leaves out optional steps** of the base (the library marks them).
2. **Picks the agent, fallback and skills** of an agent step of the base (an agent of Agent Hub's pool), or the model
   of a model step of the base.
3. **Adds steps of its own** after the base's first step (or the one the base names as `insertFrom`) and before its
   closing steps:
   - `agent` — one agent does what its instructions say, with the tools it is given, and hands back
     `{ ok, summary, findings }`;
   - `model` — one call to a model, no tools: the request, what the earlier steps handed back and its instructions go
     in, its answer (Markdown) is the step's result. For work whose input is all there — rewrite, summarise, translate,
     classify — it costs a fraction of an agent step; anything that must look something up or check it is an agent's;
   - `script` — a command in the run's folder (or the workspace), with the variables of the connectors it names;
   - `approval` — the run waits for a person: continue, or stop here;
   - `person` — the person's part: a `review` (approve, or ask for changes that go back to a step), an `input` (an
     answer the next steps build on), a `decide` (one of its choices), a `do` (something done outside, said done) or
     a `chat` (the person talks it through with an agent of the run — after findings, before a conclusion — and what
     they agree on goes to the steps after it);
   - `branch` — the run takes one of several routes; `parallel` — several lanes of read-only work at the same time;
   - `flow` — a **script step**: a short JavaScript body that drives its own steps (`wf.step`) — agents, commands,
     installed scripts, a person's answer, evidence — with loops and conditions in code. Each of its steps is kept on
     the run, so a run that stops (a restart, a crash) goes on from its first step not done. Use it when the work is
     more than a fixed line of steps: try a fix until the tests pass (at most N times), fan out over a list, pick the
     next step from what an agent found. A fixed sequence stays plain steps — they are easier to read and change.

The base's own steps keep their order and none that is required can be left out.

## How to work

1. Ask what the workflow is for until you can name: the base (what the run starts from — `blank` unless a pack's
   workflow already does most of it), the steps to add, and what each must produce. Do not guess commands, connector ids
   or agent ids: read them.
2. `workbench_workflow_library` with the base: its steps (which are optional, which take an agent and their defaults),
   the generic step kinds, the tools an agent step can be given, the agents of the pool, the connectors.
3. Write the definition (below) and check it with `workbench_workflow_validate`. Fix every error it lists. A script
   step: try its script with `workbench_workflow_try` first (nothing is asked or run: every agent, command and person
   is a stand-in) — and again with `answers` for the other paths (a failing check, an agent that says no).
4. Save a new one with `workbench_workflow_save` and `create: true` (an existing id is refused): it is saved as a **draft**. Tell the person what it does, step by step, and
   that they review and enable it on the workbench's Workflow page — you never enable a workflow yourself.
5. To change an existing one, start from `workbench_workflows` (it lists the person's definitions) and save it under
   the same id, passing its returned `revision` as `expect`. Keep its `messages`, `sessions` and pinned `packs` unless the person asked to change them. A `workflowChanged` error means it changed elsewhere: read the current definition and reconcile the request before saving again. An enabled workflow saved by you goes back to draft.

## The definition

```json
{
  "id": "research-note",
  "title": "Research, then a note",
  "description": "An agent collects sources, another drafts, the person signs off before the report",
  "base": "blank",
  "steps": [
    { "use": "intake" },
    { "id": "sources", "use": "agent", "title": "Collect sources", "agent": "sonnet", "access": "read",
      "instructions": "Find 5 reliable sources on the request. Save each as a file with file_save and hand back the list." },
    { "id": "draft", "use": "agent", "title": "Draft the note", "agent": "opus", "access": "write",
      "instructions": "Write the note from the sources (cite evidence numbers). Save the draft with file_save.",
      "onFail": { "goto": "sources", "max": 1 } },
    { "id": "sign-off", "use": "approval", "title": "Sign-off", "text": "The draft is saved: ready for the report?" },
    { "use": "report" }
  ]
}
```

- `id`: 2–40 lowercase letters, digits and dashes, not a built-in id.
- `messages` (optional, `true`): the agents of its steps may leave each other messages while they work (hand-offs,
  decisions that change another step's part, questions to another step's agent) — useful with parallel steps or a
  long chain of agents. Every agent step then has `messages_post`, `messages_read`, `messages_wait` and the
  `messages/agent-messages` skill. Messages are not evidence and not seen as requests by the person.
- A base step: `{ "use": "<its key>" }`, and for an agent step optionally `"agent"`, `"fallback"` (`""`: none),
  `"skills": ["pack/skill"]`; any base step may add `cli` (below).
- `cli` (an agent, script or base step; optional): the command-line tools the step uses that the image does not have,
  up to 20 — `"golangci-lint"`, `"shellcheck@0.11.0"`, or `"<backend>:<package>[@version]"` with the backend `aqua`,
  `github`, `gitlab`, `ubi`, `pipx` or `npm` (`"pipx:bandit"`, `"npm:prettier"`). Each machine installs them with mise
  into its home before the step runs (no root; Linux and macOS); one mise cannot install (a Docker engine, a system
  library) stops the step and says how a person installs it. Name only what the step's commands really run.
- `agent` step: `id`, `title`, `instructions` (what to do and what to hand back — the agent sees the run's context
  and this text, nothing else), `agent`, optional `fallback`, `access` (`read` | `write`), `skills`, `tools` (names from
  the library; the step always has wb_context, evidence_get, claim_add, decision_needed, help_needed, discuss_with_person, file_save, stage_result, and tools_ensure when `access` is `write`),
  `cli`, `onFail`. Whatever must be kept goes through `file_save`: that puts it in the evidence ledger and the report.
  An agent step hands back a `confidence` (0–100) with its result, and may ask the person for what only a person can give
  (`help_needed`, at most three times in a step; the run waits and the step runs again with the answer) — or ask to
  talk something through (`discuss_with_person`: the person talks with it, and the step runs again with what was agreed).
- Any step but an approval or a person step may say when it asks the person: `"human": { "stuck": true, "below": 70,
  "wait": 24 }` — `stuck`: it failed where the run would stop; `below` (1–100): the confidence it handed back is under this
  bar; `wait`: hours until the person is reminded (default 24, 0: never; the run keeps waiting, nothing is decided for them).
- `model` step: `id`, `title`, `instructions` (what to make of the request and the earlier steps' results — the model
  sees those and this text, nothing else: no files, no tools), `model` (`"<connection>:<model>"` — a connection that
  speaks the OpenAI chat API, e.g. `"openrouter:anthropic/claude-sonnet-5.5"` — or `"dsh:<provider>/<model>"`; left out:
  the workbench's default model), `onFail`. It may stand in a route or a parallel lane.
- A base step that is a model step: `{ "use": "<its key>", "model": "…" }` picks its model.
- `script` step: `id`, `title`, `run` (bash) — or, instead of `run`, `script: "<name>@<version>"` with `args` (a list):
  an installed script (listed by workbench_workflow_library under `scripts`; its folder is `$SCRIPT_DIR` when it
  runs) —, `cwd` (`run`: the run's folder, the default | `workspace`: the folder set in the settings),
  `timeoutMinutes` (1–120), `connectors` (what it connects to, by type: `[{ "type": "http", "level": "read" | "write",
  "name"?: "two-of-a-type" }]` — each machine binds it to one of its connections; the older `{ "<connector id>": level }`
  names one connection — the command gets only those variables; write needs an approval or a review before it on its
  path), `cli`, `onFail`.
- `approval` step: `id`, `title`, `text` (what the person decides).
- `person` step: `id`, `title`, `ask` (`review` | `input` | `decide` | `do` | `chat`), `text` (what it asks of the person),
  `wait` (hours before the person is reminded, 0–720; 0: no reminder — by default 24 for input, 72 for do, none for
  review and decide). A `review` may name `back` (an earlier step: "ask for changes" sends the run there with the
  person's notes in its brief); a `decide` has `options` (2–6: `{ "label", "to"?: "<an earlier step>" }` — a choice
  with `to` sends the run back there). A `chat` talks with the agent of `with` (an earlier agent step; none: the latest
  one before it that ran) — in that agent's session when the workflow has `sessions: true`, else from the run's record —
  for as long as the person likes; settled, the agent writes what was agreed, which every later step is told; it may
  name `back` (an earlier step to redo with it). What it hands back (`input`: the answer; `decide`: the choice;
  `review`: the verdict; `chat`: `settled`, what was agreed) is what a later branch's `{ "output": "<its id>", "has":
  "…" }` reads. Not in a parallel lane.
  A `review` shows the work and loops in the step itself: the person comments on a passage, some lines, a part of an
  image, a moment of a video (or the whole), may edit a file, and chooses "Revise with my notes" — an agent changes the
  files now and answers each comment, and the person looks again. Its own settings (all optional): `show` (paths in
  the run's folder, `*` allowed: `["draft.md", "posts/*.json"]`; none: what the step before changed), `revisedBy`
  (the id of an agent step before it whose agent revises; none: the nearest agent step before it; `false`: no
  revising in place — approve, send back or stop only), `rounds` (how many revisions, 1–20, default 5), `gather`
  (`true`: that agent first writes a note for the person — what was done, where to look). Put a review where the
  person must see the work before it goes on or goes out (a draft before it is adapted, a cut before it is published).
- `output` step (结果): `id`, `title`, `text` (optional), `show` (optional: paths in the run's folder, `*` allowed; none:
  every file the run made or changed up to there). It waits for nobody: it names the run's results, which the person
  opens on the run page (PDF, web page, video, images, documents), comments on, and starts the run again from a step
  of their choosing with the comments. Put one after the steps that make the deliverable.
- `branch` step (the main line only, where steps of one's own may go): `id`, `title`, `mode` (`condition` | `agent`),
  `routes` (1–5: `{ "id", "label", "steps": [agent / model / script / approval / person steps] }` plus, by condition, `"when"`:
  `{ "step": "<an earlier step>", "is": "passed" | "failed" | "skipped" }` (`failed` only for a step of yours whose
  `onFail` is `"continue"`), `{ "output": "<an earlier agent, model, script or person step>", "has": "text" }` or
  `{ "verdict": "<a level>" }`; by agent, `"hint"`: when to take it), `otherwise` (`{ "label", "steps" }`, may be
  empty: straight on). An agent branch also has `agent`, optional `fallback` and `instructions` (how to decide). The
  run takes one route, skips the others ("not on this path") and goes on with the step after the branch.
- `parallel` step: `id`, `title`, `lanes` (2–5: `{ "id", "label", "steps": [read-only agent / model / script steps] }`),
  `onFail`. The run goes on when every lane is through.
- `flow` step (on the main line): `id`, `title`, `source` (the script, below), `agents` (`{ "<role>": { "agent": "<an
  agent of the pool>", "fallback"?: "…", "access": "read" | "write", "instructions"?: "what this role is for" } }` — every
  role the script asks), `params` (`{ "<name>": { "title": "…", "default": "…" } }`, optional), `cli`, `onFail`, `human`.
- `onFail`: `"stop"` (the default: nothing after it runs), `"continue"`, or `{ "goto": "<an earlier step>", "max": n }`.
- What it needs — its agents, its skills (their packs are pinned when it is saved), its connections, its models, its
  installed scripts, its command-line tools (`cli`: installed with mise when needed) — is checked on each machine before a run starts: a run that is not ready does not start and says
  what is missing (the Workflows page shows it, and binds a connection need to a connection of this machine).

## A script step (`use: "flow"`)

The script is the body of an async function. It sees only `wf`:

- `await wf.step(name, async s => { … }, { retries?: 0–10, title?: "…" })` — one step. Its result (JSON, at most 64 KB)
  is kept: a run that comes back here gets it at once, without doing the step again. A loop's turns are steps of their
  own (`fix · 1`, `fix · 2`). A step that throws is tried again up to `retries`, then the script stops with its error.
- Inside a step, through its handle `s` (only there — outside a step it is refused):
  - `s.agent(role, prompt, { title? })` → `{ ok, summary, findings, confidence? }` — an agent of the step's `agents`
    does the task (the run's context, the evidence tools and `stage_result`, like an agent step). One at a time.
  - `s.sh(command, { cwd?: "run" | "workspace", timeoutMinutes?: 1–120, allowFail? })` → `{ code, stdout, stderr }` —
    bash in the run's folder; a non-zero exit throws unless `allowFail`. Recorded in the ledger.
  - `s.script("name@version", [args], { allowFail? })` → as `s.sh` — an installed script (listed by the library).
  - `s.ask(question, { options?: ["A", "B"], waitHours? })` → `{ answer, input, choice }` — the run waits for the
    person (an answer, or one of the options); a person who stops it stops the run (no retry).
  - `s.evidence(title, data)` — something the run's record keeps for whoever reviews it.
  - `s.now()` — the time inside this step, kept (the same when the step runs again).
- `wf.params` (its parameters: the run's, else the defaults), `wf.input` (`{ run: { id, title, template }, request:
  { title, text, fields }, outputs: { "<earlier step>": { ok, summary } } }`), `wf.now()` (the time between steps, kept;
  not while a step is at work), `wf.log(text)`, `wf.phase(title)`,
  `wf.parallel([b => b.step(…), b => b.step(…)])` — branches at the same time, each taking its own steps through its
  `b` (`wf.step` inside one is refused: the steps of a branch are its own, so a resumed run matches them); not two
  agents at once (they take turns), and a person's cards one at a time.
- `return { summary: "…" }` — the step's outcome (a branch after it can read `summary`); a thrown error fails the step
  (its `onFail`).

Rules that keep a resumed run right:

- **The work goes in steps.** Everything outside a step runs again each time the run comes back; inside one, once.
- **Decide from what steps return**, never from the clock or chance: `Date.now()`, `new Date()` and `Math.random()`
  are refused (`wf.now()` between steps and `s.now()` inside one are kept). The script has no modules, network, timers,
  `process` or `eval`: what it does goes through `s`.
- **A step may run again** if the run stopped in the middle of it: make each one safe to repeat (a command that checks
  before it changes, a file name that is the same each time).
- **Name steps with literals** (`wf.step('fix', …)`) and roles too (`s.agent('coder', …)`), so the editor, the
  readiness check and the reader see them.

```json
{ "id": "fix-until-green", "use": "flow", "title": "Fix until the tests pass",
  "agents": { "coder": { "agent": "codex", "fallback": "opus", "access": "write" } },
  "params": { "tries": { "title": "How many fixes to try", "default": 3 } },
  "source": "const plan = await wf.step('plan', s => s.agent('coder', 'Read the request and the files; say what to change and how to test it.'))\nif (!plan.ok) throw new Error('no plan: ' + plan.summary)\nfor (let i = 1; i <= Number(wf.params.tries); i++) {\n  await wf.step('fix', s => s.agent('coder', 'Make the change (try ' + i + '):\\n' + plan.summary))\n  const t = await wf.step('test', s => s.sh('make test', { allowFail: true, timeoutMinutes: 20 }))\n  if (t.code === 0) return { summary: 'tests pass after ' + i + ' fix(es)' }\n  await wf.step('note', s => s.evidence('test failure ' + i, t.stdout.slice(-2000)))\n}\nconst go = await wf.step('ask', s => s.ask('The tests still fail after ' + wf.params.tries + ' tries. Go on to the report?', { options: ['Go on', 'Stop'] }))\nif (go.choice !== 'Go on') throw new Error('stopped: the tests still fail')\nreturn { summary: 'tests still failing; the person went on' }" }
```

## Rules that stay

- A workflow of the person's never sends anything out by itself: what leaves the machine is an approval card a pack's
  workflow makes, and a person approves it.
- A script step's output goes into the evidence ledger with every connector value taken out; keep secrets out of
  the command itself.
- Prefer a step the person can read in one line: a clear title, short instructions, one purpose.
