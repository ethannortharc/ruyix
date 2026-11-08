// The read ops boards call (every op of @ruyix/board's catalog is read here and gives exactly its fields; nothing but
// reads goes out), and a kubeconfig's token in a nookbox box: in the box while the cluster is passed through, to the
// host's vault once the box's policy trusts the cluster's CA.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnectors, memoryCredentials } from './lib/service.js'
import { TYPES } from './lib/types.js'
import { READS } from './lib/reads.js'
import { OPS } from '../board/schema.js'

// ── reads ──
{
  assert.deepEqual(Object.fromEntries(Object.entries(READS).map(([t, ops]) => [t, Object.keys(ops).sort()])), Object.fromEntries(Object.entries(OPS).map(([t, ops]) => [t, Object.keys(ops).sort()])), 'the same catalog')
  const calls = []
  const reply = {
    '/api/v4/projects/grp%2Fapp/merge_requests': [{ id: 1, iid: 7, title: 'Fix', author: { username: 'ann' }, state: 'opened', draft: false, source_branch: 'b', target_branch: 'main', updated_at: '2026-10-12T00:00:00Z', web_url: 'https://gl.example/x/7' }],
    '/api/v4/projects/grp%2Fapp/pipelines': [{ id: 9, ref: 'main', status: 'failed', source: 'push', sha: 'abcdef0123456789', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:01:00Z', web_url: 'https://gl.example/p/9' }],
  }
  const fetch = async (url, init) => {
    const u = new URL(url)
    calls.push({ host: u.host, path: u.pathname, method: init.method || 'GET', auth: init.headers?.authorization || init.headers?.['private-token'] || '' })
    const body = reply[u.pathname]
    return new Response(JSON.stringify(body ?? { error: 'nope' }), { status: body ? 200 : 404, headers: { 'content-type': 'application/json' } })
  }
  const run = async (cmd, args) => {
    if (cmd === 'kubectl' && args.includes('events')) return { code: 0, stdout: JSON.stringify({ items: [{ lastTimestamp: '2026-10-12T00:00:00Z', type: 'Warning', reason: 'BackOff', involvedObject: { kind: 'Pod', name: 'api-1' }, message: 'restarting', metadata: { creationTimestamp: '2026-10-12T00:00:00Z' } }] }), stderr: '' }
    if (cmd === 'kubectl') return { code: 0, stdout: JSON.stringify({ items: [{ kind: 'Deployment', metadata: { name: 'api', namespace: 'ns', creationTimestamp: '2026-10-12T00:00:00Z' }, spec: { replicas: 2, template: { spec: { containers: [{ image: 'reg/x/api:1.2' }] } } }, status: { readyReplicas: 1 } }] }), stderr: '' }
    return { code: 1, stdout: '', stderr: 'unexpected' }
  }
  const r = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-reads-')), creds: memoryCredentials(), fetch, run })
  await r.save({ id: 'gl', type: 'gitlab', baseUrl: 'https://gl.example' }); await r.setSlot('gl', 'read', 'glpat-read-only-1'); await r.setSlot('gl', 'write', 'glpat-write-only-1')
  await r.save({ id: 'kc', type: 'k8s', fields: { namespace: 'ns' } }); await r.setSlot('kc', 'kubeconfig', 'apiVersion: v1\nclusters: []\n')
  for (const [id, op, params] of [['gl', 'mrs.list', { project: 'grp/app' }], ['gl', 'pipelines.list', { project: 'grp/app' }], ['kc', 'workloads', {}], ['kc', 'events', {}]]) {
    const rows = await r.read(id, op, params), type = r.get(id).type
    assert.ok(rows.length > 0, `${type} ${op} gives rows`)
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), Object.keys(OPS[type][op].fields).sort(), `${type} ${op} gives its fields`)
  }
  assert.deepEqual((await r.read('kc', 'workloads', {}))[0], { name: 'api', namespace: 'ns', kind: 'Deployment', ready: 1, desired: 2, image: 'api:1.2', updated: '2026-10-12T00:00:00Z' })
  assert.ok(calls.every(x => x.method === 'GET'), 'reads only')
  assert.ok(!calls.some(x => x.auth.includes('write')), 'never the write token')
  await assert.rejects(r.read('gl', 'issues.list', {}), e => e.code === 'noRead')
  await assert.rejects(r.read('gl', 'pipelines.list', {}), e => e.code === 'readFailed' && /project is not set/.test(e.message))
}

// ── a kubeconfig's token in a box ──
{
  const put = [], gone = []
  let policy = { passthrough: ['10.65.0.7'], trust: {} }, clock = 0
  const fakeVault = { put: async (name, b) => { put.push({ name, ...b }); return { placeholder: `glpat-NKB${'a'.repeat(32)}`, hosts: b.hosts } }, remove: async name => { gone.push(name) }, policy: async () => policy }
  const bx = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-box-')), creds: memoryCredentials(), vault: fakeVault, now: () => clock })
  const kube = 'apiVersion: v1\nclusters:\n- cluster:\n    certificate-authority-data: Q0EK\n    server: https://10.65.0.7:6443\n  name: home\nusers:\n- name: sa\n  user:\n    token: eyJreal.token-0123456789\n'
  await bx.save({ id: 'k2', type: 'k8s', fields: { namespace: 'x' } })
  await bx.setSlot('k2', 'kubeconfig', kube)
  assert.equal(put.length, 0, 'passed through: the token stays in the box')
  const file = async id => readFileSync((await bx.env(id)).KUBECONFIG, 'utf8')
  assert.match(await file('k2'), /token: eyJreal/)
  policy = { passthrough: [], trust: { '10.65.0.7': '-----BEGIN CERTIFICATE-----' } }
  clock += 61e3 // the box's policy is read again after a minute
  const moved = await file('k2')
  assert.deepEqual(put[0], { name: 'CONN_K2__KUBECONFIG', value: 'eyJreal.token-0123456789', hosts: ['10.65.0.7'], body: false }, 'kept from before: moved on its first use')
  assert.match(moved, new RegExp(`token: glpat-NKB${'a'.repeat(32)}`))
  assert.ok(!/eyJreal|certificate-authority/.test(moved), 'no token, no cluster CA left in the file')
  assert.match(moved, /server: https:\/\/10\.65\.0\.7:6443/)
  await file('k2')
  assert.equal(put.length, 1, 'once')
  await bx.save({ id: 'k3', type: 'k8s', fields: { namespace: 'x' } })
  await bx.setSlot('k3', 'kubeconfig', kube.replace('eyJreal', 'eyJnew'))
  assert.equal(put[1].name, 'CONN_K3__KUBECONFIG', 'a new one: to the vault as it is set')
  // flow style: the token in braces, the CA quoted beside the server
  const flow = 'apiVersion: v1\nkind: Config\nclusters: [{ name: dev, cluster: { server: "https://10.65.0.7:6443", certificate-authority-data: "LS0tQ0EK" } }]\nusers: [{ name: wb, user: { token: eyJflow.tok-0123456789 } }]\n'
  await bx.save({ id: 'k4', type: 'k8s', fields: { namespace: 'x' } })
  await bx.setSlot('k4', 'kubeconfig', flow)
  assert.equal(put[2].value, 'eyJflow.tok-0123456789')
  assert.equal((await bx.list()).find(x => x.id === 'k4').baseUrl, 'https://10.65.0.7:6443', 'the address read from flow style too')
  const flowFile = await file('k4')
  assert.match(flowFile, new RegExp(`user: \\{ token: glpat-NKB${'a'.repeat(32)} \\}`))
  assert.match(flowFile, /cluster: \{ server: "https:\/\/10\.65\.0\.7:6443" \}/, 'the CA entry gone, the flow map still whole')
  const head = 'clusters: [{ name: d, cluster: { certificate-authority-data: "X", server: "https://h:1" } }]\n'
  assert.equal(TYPES.k8s.slots[0].vaulted.trust(head), 'clusters: [{ name: d, cluster: { server: "https://h:1" } }]\n', 'the CA first in its map')
  assert.equal([...'  id-token: eyJx\n  refresh-token: r\n'.matchAll(TYPES.k8s.slots[0].vaulted.secrets)].length, 0, 'not a token: key')
  await bx.clearSlot('k3', 'kubeconfig')
  assert.deepEqual(gone, ['CONN_K3__KUBECONFIG'])
}
{ // Every token in a file has its own stable vault slot, and clear/remove revoke all of them.
  const active = new Map(), put = [], gone = [], creds = memoryCredentials()
  let serial = 0, failSecond = false
  const vault = {
    policy: async () => ({ trust: { 'cluster.example': 'ca' }, passthrough: [] }),
    put: async (name, body) => {
      put.push(name)
      const placeholder = active.get(name)?.placeholder || `NKB${String(++serial).padStart(32, 'a')}`
      active.set(name, { ...body, placeholder }); return { placeholder }
    },
    remove: async name => { if (failSecond && name.endsWith('_2')) { failSecond = false; throw new Error('vault offline') } gone.push(name); active.delete(name) },
  }
  const kc = createConnectors({ home: mkdtempSync(join(tmpdir(), 'connectors-vault-file-')), creds, vault })
  const kube = tokens => `apiVersion: v1\nclusters:\n- name: cluster\n  cluster:\n    server: https://cluster.example\nusers:\n${tokens.map((v, i) => `- name: u${i}\n  user:\n    token: ${v}\n`).join('')}`
  const names = ['CONN_MULTI__KUBECONFIG', 'CONN_MULTI__KUBECONFIG_2']
  await kc.save({ id: 'multi', type: 'k8s', fields: { namespace: 'x' } })
  await kc.setSlot('multi', 'kubeconfig', kube(['secret-one', 'secret-one-long']))
  const values = [...(await creds.get('multi')).kubeconfig.matchAll(TYPES.k8s.slots[0].vaulted.secrets)].map(m => m[2])
  assert.deepEqual(values, names.map(n => active.get(n).placeholder), 'replacing a shorter token cannot corrupt another token with the same prefix')
  await kc.setSlot('multi', 'kubeconfig', kube([values[0], 'changed']))
  assert.equal(put.at(-1), names[1], 'a preserved placeholder keeps its index when another token changes')
  assert.equal(active.get(names[0]).value, 'secret-one')
  await kc.setSlot('multi', 'kubeconfig', kube(['single']))
  assert.ok(!active.has(names[1]), 'shrinking the file clears its old suffix slots')
  await kc.setSlot('multi', 'kubeconfig', kube(['one', 'two']))
  await kc.clearSlot('multi', 'kubeconfig')
  assert.equal(active.size, 0)
  await kc.setSlot('multi', 'kubeconfig', kube(['one', 'two']))
  failSecond = true
  await assert.rejects(kc.remove('multi'), /vault offline/)
  assert.ok(kc.has('multi'), 'failed revocation stays retryable instead of silently losing the connection')
  await kc.remove('multi')
  assert.equal(active.size, 0)
  assert.deepEqual([...new Set(gone)].sort(), names)
  assert.deepEqual([...new Set(put)].sort(), names)
}
console.log('reads and box check: ok')
