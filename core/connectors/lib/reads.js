// The read ops a dataset may call, per connector type — the names and fields are @ruyix/board's OPS; here is how each
// reads its service. Read only: the read slot and GETs. Each returns rows with the op's fields; the dataset then keeps
// only its own (board's shapeRows) before a board shows them.

const enc = encodeURIComponent
const MAX_ROWS = 2000
const qs = o => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : v == null || v === '' ? [] : [[k, String(v)]]))).toString()
const within = (n, max = MAX_ROWS) => Math.max(1, Math.min(Number(n) || 100, max))
const need = (p, ...keys) => { for (const k of keys) if (p[k] == null || p[k] === '') throw new Error(`${k} is not set (the board's settings)`) }

async function get(api, path, opts) {
  const res = await api.request(path, opts)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

export const READS = {
  gitlab: {
    async 'mrs.list'(api, p) {
      const path = p.project ? `/api/v4/projects/${enc(p.project)}/merge_requests` : '/api/v4/merge_requests'
      const list = await get(api, `${path}?${qs({ state: p.state || 'opened', target_branch: p.target, scope: p.project ? undefined : 'all', per_page: within(p.limit, 100) })}`)
      return list.map(m => ({
        id: String(m.id), ref: `!${m.iid}`, title: m.title, author: m.author?.username || '', state: m.draft ? 'draft' : m.state, source: m.source_branch, target: m.target_branch,
        pipeline: m.head_pipeline?.status || null, updated: m.updated_at, url: m.web_url,
      }))
    },
    async 'pipelines.list'(api, p) {
      need(p, 'project')
      const list = await get(api, `/api/v4/projects/${enc(p.project)}/pipelines?${qs({ ref: p.ref, status: p.status, per_page: within(p.limit, 100) })}`)
      return list.map(x => ({ id: String(x.id), ref: x.ref, status: x.status, source: x.source, sha: String(x.sha || '').slice(0, 10), created: x.created_at, updated: x.updated_at, url: x.web_url }))
    },
  },
  k8s: {
    async workloads(api, p) {
      const out = await kube(api, ['-n', p.namespace || api.conn.fields.namespace, 'get', 'deployments,statefulsets', '-o', 'json'])
      return out.items.map(x => ({
        name: x.metadata.name, namespace: x.metadata.namespace, kind: x.kind, ready: x.status?.readyReplicas || 0, desired: x.spec?.replicas ?? 0,
        image: (x.spec?.template?.spec?.containers || []).map(c => c.image.split('/').pop()).join(', '), updated: x.metadata.creationTimestamp,
      }))
    },
    async events(api, p) {
      const out = await kube(api, ['-n', p.namespace || api.conn.fields.namespace, 'get', 'events', '-o', 'json', ...(p.type ? [`--field-selector=type=${p.type}`] : [])])
      return out.items.map(e => ({ at: e.lastTimestamp || e.eventTime || e.metadata.creationTimestamp, type: e.type, reason: e.reason, object: `${e.involvedObject?.kind}/${e.involvedObject?.name}`, message: String(e.message || '').slice(0, 300) }))
        .sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, within(p.limit, 500))
    },
  },
}

async function kube(api, args) {
  const r = await api.kubectl([...args, '--request-timeout=20s'])
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').at(-1).slice(0, 300))
  return JSON.parse(r.stdout)
}
