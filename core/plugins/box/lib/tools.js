// Tools for every AI session in this dsh: what the nookbox box it runs in is and has done — so an assistant can say which
// hosts a run reached, which credentials went where, what ran, what the models cost. Read-only, like the box's window;
// changing the box (policy, credentials, mounts) is the host's: the tools say which host command does it, never that it is done.
import { aiWorkText, flowLine, insightsText, usageByModel } from './box.js'

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const textResult = { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: v.text }] }
const clip = (s, n = 30000) => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s)
const text = t => ({ text: clip(String(t)) })
const HOST_ONLY = 'Changing the box (credentials, policy, mounts, ports) is done on the host with the nookbox CLI or its UI, never from inside the box: give the command, do not claim it was done.'

export function boxTools({ api, aiWork }) {
  return [
    {
      name: 'nookbox_box', description: 'The nookbox box this session runs in: name, runtime (microVM or container), image, what the audit sees (network, DNS, process sensor), the egress policy, published ports, the host folders mounted into it (host path → box path), and the credentials bound to it (names, the hosts each may go to, the environment variable holding its placeholder — never a value).',
      parameters: schema({}), output: textResult,
      async execute() {
        const { box: b, credentials } = await api().box()
        const s = b.spec, cov = b.agent?.coverage
        return text([
          `Box ${b.name} (${b.state}), ${s.runtime}${s.oci_runtime ? ` via ${s.oci_runtime}` : ''}, ${s.cpus || '?'} CPUs, ${s.memory_mb || '?'} MiB${s.image ? `, from ${s.image}` : ''}`,
          `Audit: network ${cov?.net ? 'yes' : 'no'}, DNS ${cov?.dns ? 'yes' : 'no'}, processes ${cov?.sensor || 'unknown'}${cov?.notes?.length ? ` (${cov.notes.join('; ')})` : ''}`,
          `Egress policy: ${s.policy.mode}${s.policy.allow?.length ? `, allow ${s.policy.allow.join(', ')}` : ''}${s.policy.deny?.length ? `, deny ${s.policy.deny.join(', ')}` : ''}${s.policy.allow_private ? ', private addresses allowed' : ''}${s.policy.allow_exfil === false ? ', paste/file-drop/tunnel/request-catcher services refused' : s.policy.allow_exfil ? ', paste/file-drop/tunnel services allowed' : ''}`,
          `Ports: ${s.ports.map(p => `host 127.0.0.1:${p.host} → box ${p.guest}`).join(', ') || 'none'}`,
          `Host folders: ${(s.mounts || []).map(m => `${m.source} → box ${m.target}${m.mode === 'ro' ? ' (read-only)' : ''}`).join(', ') || 'none'} (add one on the host: nookbox update ${b.name} --mount <folder>, which restarts the box)`,
          'Credentials:', ...(credentials.length ? credentials.map(c => `- ${c.name} (${c.kind}${c.login ? ', login' : ''}${c.set ? '' : ', not set yet'}): ${c.hosts.join(', ') || 'no host'}${c.env.length ? `; in $${c.env.join(', $')}` : ''}`) : ['- none']),
          HOST_ONLY,
        ].join('\n'))
      },
    },
    {
      name: 'nookbox_traffic', description: 'HTTP(S) exchanges this box made, newest first, as recorded by the nookbox gateway: method, URL, status, time, bytes, which credentials were substituted, and model token usage. Optional host filter.',
      parameters: schema({ host: { type: 'string', description: 'only this host' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }), output: textResult,
      async execute({ host, limit = 50 }) {
        const rows = await api().flows({ host, limit })
        return text(rows.length ? rows.map(flowLine).join('\n') : 'No HTTP exchanges recorded.')
      },
    },
    {
      name: 'nookbox_timeline', description: 'What happened in this box, newest first: processes run (exec), files opened (file), connections (net), DNS lookups (dns), policy refusals and credential violations, lifecycle. Optional kinds and text filter.',
      parameters: schema({ kinds: { type: 'array', items: { type: 'string', enum: ['exec', 'file', 'net', 'dns', 'http', 'policy', 'violation', 'lifecycle', 'agent', 'session', 'secret'] } }, text: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 500 } }), output: textResult,
      async execute({ kinds, text: q, limit = 100 }) {
        const rows = await api().events({ kinds, text: q, limit })
        return text(rows.length ? rows.map(e => `${new Date(e.ts).toISOString()} ${e.kind} ${e.severity} ${e.summary}`).join('\n') : 'No events.')
      },
    },
    {
      name: 'nookbox_insights', description: 'How this box has been doing: a health score with its reasons; security findings from the audit rules (a credential sent where it should not go, a real secret inside the box, dangerous or destructive commands, secret files printed or sent, data-moving services, refused TLS); how each client fared (requests, failure rate, latency, model tokens, cache hits — claude, codex, dsh, node, git, …); what looks off (auth refusals, rate limits, server errors, a request failing over and over, bursts); destinations new in the window. Ask it before saying whether anything unsafe or unusual happened.',
      parameters: schema({ hours: { type: 'integer', minimum: 1, maximum: 2160, description: 'the window, in hours (default 24)' } }), output: textResult,
      async execute({ hours = 24 }) {
        return text(insightsText(await api().insights({ hours }), hours))
      },
    },
    {
      name: 'nookbox_ai_work', description: 'The AI work done in this Ruyix over a window — every Agent Hub task (a workflow step\'s, a chat job\'s) and the workbench\'s own model calls: by agent (tasks, success rate, how often a step\'s work was kept, tokens, cost, model) and by model — and which tasks were running when the box saw each security finding and anomaly (matched by time, and by runtime when the box names the client). Ask it to tell which agent did something unsafe or odd.',
      parameters: schema({ hours: { type: 'integer', minimum: 1, maximum: 2160, description: 'the window, in hours (default 24)' } }), output: textResult,
      async execute({ hours = 24 }) {
        const [w, ins] = await Promise.all([aiWork(hours), api().insights({ hours }).catch(() => null)])
        return text(aiWorkText(w, ins, hours))
      },
    },
    {
      name: 'nookbox_usage', description: 'Model token usage of this box by model (input, output, cache read/write, requests) over the last days, from the API traffic the gateway saw.',
      parameters: schema({ days: { type: 'integer', minimum: 1, maximum: 365 } }), output: textResult,
      async execute({ days = 7 }) {
        const by = usageByModel(await api().usage({ days }))
        return text(by.length ? [`Last ${days} days:`, ...by.map(m => `- ${m.provider}/${m.model}: ${m.requests} requests, in ${m.input}, out ${m.output}, cache read ${m.cacheRead}, cache write ${m.cacheWrite}`)].join('\n') : `No model traffic in the last ${days} days.`)
      },
    },
  ]
}

/** Every agent of this dsh gets the tools (a box is one machine: every session in it is in it). */
export function setupTools(ctx, deps) {
  const equipped = new Map()
  const equip = agent => {
    if (equipped.has(agent) || !agent?.ctx?.tools) return
    const disposers = boxTools(deps).map(tool => agent.ctx.tools.register(tool))
    equipped.set(agent, () => disposers.forEach(d => d?.()))
  }
  for (const agent of ctx.agents?.list?.() || []) equip(agent)
  ctx.on?.('agent/created', ({ agent }) => equip(agent))
  ctx.on?.('agent/disposed', ({ agent }) => { equipped.get(agent)?.(); equipped.delete(agent) })
  ctx.effect(() => () => { for (const d of equipped.values()) d(); equipped.clear() }, 'box: assistant tools')
}
