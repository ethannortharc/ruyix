# @ruyix/box

The nookbox box this dsh runs in, inside dsh: one UI for the workbench and its sandbox.

- **Overview** — the box (runtime, image, resources, ports, host folders, start command), what the audit sees (network, DNS,
  processes and files by eBPF or `/proc`), the egress policy, the credentials it holds placeholders for (names, the
  hosts each may go to — never a value), and the host commands that change any of it.
- **Insights** — how the box has been doing over a day, a week or a month: a health score with its reasons; the security
  findings of nookbox's audit rules (a credential headed where it should not go, a real secret inside the box, dangerous or
  destructive commands, secret files printed or sent, data-moving services, refused TLS), grouped with counts; how each
  client fared (Claude Code, Codex, dsh, node, git, the browser…: requests, failure rate, p50/p95, model calls, cache hits);
  what looks off (auth refusals, rate limits, server errors, a request failing over and over, bursts); new destinations;
  the destinations (each host: requests, failure rate, p50/p95, data, which clients, first seen — the busiest, the
  slowest, the most failing) and the window's latency; requests by hour. nookbox computes it on the host from its
  hourly counts (`/v1/insights`, nookbox 0.5.0 or later; destinations and latency 0.5.6). Each part loads by itself: the
  page draws at once with skeletons, a tab asks only when it is opened, each window's last answer shows at once and is
  refreshed behind it, and the tables and the chart are drawn as they come into view.
  Beside it, the **AI work** of the workbench (its `aiWork`, through Ruyix's parts): Agent Hub's tasks by agent — tasks,
  success, how often a step's work was kept, tokens, cost, model — and the models; under each finding and anomaly, the
  tasks that were running then (by time, a minute of slack; by runtime when the box names an agent client). Without a
  workbench the card says so; without Agent Hub, only the workflow steps in the workbench's ledger are known.
- **Traffic** — every HTTP(S) exchange the gateway recorded, with headers, bodies, credentials substituted and model
  tokens.
- **Timeline** — processes, files, connections, DNS, policy refusals and violations, lifecycle; what the rules flagged carries
  its risk. Repeated or bulk file opens arrive folded (`node open …/settings.json ×58`, `cp open /home/nook/.dsh/… ×208074`).
- **Usage** — model tokens by model.
- **Tools** for every AI session: `nookbox_box`, `nookbox_traffic`, `nookbox_timeline`, `nookbox_insights`, `nookbox_ai_work`, `nookbox_usage`.

It reads the box's own window on nookbox, `http://nookbox.internal/v1` (nookbox gives the box `NOOKBOX_API`): the
nookbox gateway answers it for the box the request comes from — no token, read-only, that box only. So nothing in the
box, an assistant included, can change its own sandbox through this plugin; the panel shows the host command instead.
Outside a box the panel says so. Settings (`~/.ruyix/box/settings.json`): `api`, the window's address (empty = the
one nookbox gives).

**The host's code in the box.** On the host, `nookbox update <box> --mount ~/code/app` mounts that folder at
`/workspace/app` (the box restarts; its home, credentials and ports stay). The box user has the host user's uid and gid,
so git needs no `safe.directory` and what the box writes is the host user's. The workbench lists the mounted folders
under Settings → Workspace. Its runs check out into worktrees in the box's home, so a host-side `git worktree prune` in
that repository drops their registration: don't prune while runs are open.

`node build.mjs` builds `client.js` from `src/`; `node check.mjs` checks the host half against a fake box window.
