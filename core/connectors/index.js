// @ruyix/connectors: every service ruyix reaches — GitLab, Kubernetes, any HTTP API — as connections. A connection is data without secrets (~/.ruyix/connectors/
// connections.json); its credentials are in dsh's credential store; the products name the connections they use and
// reach them only through the service `connectors` (a client that adds the credential, a command with exactly its
// variables, a private file for the tools that read one). The Connectors page adds, tests and signs in.
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME, createConnectors, dshCredentials } from './lib/service.js'
import { createSignin } from './lib/signin.js'
import { boxVault } from './lib/vault.js'

export const inject = ['connection', 'agents']
const coded = (code, params, message) => Object.assign(new Error(message), { code, params })
const HOUR = 3600e3

// the browser runtime (Playwright) lives in the workbench's home
const WB = join(homedir(), '.ruyix/workbench')

export function apply(ctx, _config, { home = HOME, creds: given, run, fetch, runtimeDir = join(WB, 'ui-runtime'), vault = boxVault(process.env.NOOKBOX_API) } = {}) {
  // dsh's credential store, while it is there (a composition without one has none: every credential reads as unset)
  let store = given || null
  if (!given) {
    ctx.inject(['credentials'], inner => {
      store = dshCredentials(inner.credentials)
      inner.effect(() => () => { store = null }, 'connectors: credentials')
    })
  }
  const none = () => { throw coded('noCredentials', {}, 'dsh\'s credential store is not loaded') }
  const creds = new Proxy({}, { get: (_t, k) => (...a) => (store ? store[k](...a) : k === 'get' ? Promise.resolve({}) : k === 'getRef' ? Promise.resolve('') : none()) })
  const service = createConnectors({ home, creds, run, fetch, vault })

  const signin = createSignin({
    runtimeDir, home: join(home, 'signin'),
    async save(id, kept, ticket) {
      await service.keepSignin(id, ticket, kept)
      await service.test(id).catch(() => {})
    },
    log: m => ctx.logger?.info?.(`connectors: ${m}`),
    forget: !!vault,
  })
  ctx.effect?.(() => () => { signin.stop() }, 'connectors: sign-in browser')

  // The home page's step: the connections the products need, and what is wrong with them.
  service.setup = () => {
    const needs = service.needs().filter(n => !n.optional)
    const bad = needs.filter(n => n.state !== 'ok' && n.state !== 'untested')
    const words = (lang, n) => `${n.label?.[lang] || n.label?.en || n.type} (${{ missing: lang === 'zh' ? '未添加' : 'not added', wrongType: lang === 'zh' ? '类型不对' : 'wrong type', unset: lang === 'zh' ? '凭据未填' : 'not set', failed: lang === 'zh' ? '测试失败' : 'test failed' }[n.state]})`
    return [{
      id: 'connections', order: 15, required: true, ready: !bad.length, panel: 'connectors',
      title: { en: 'Connectors', zh: '连接器' },
      detail: bad.length
        ? { en: bad.slice(0, 3).map(n => words('en', n)).join(', ') + (bad.length > 3 ? ', …' : ''), zh: bad.slice(0, 3).map(n => words('zh', n)).join('，') + (bad.length > 3 ? '……' : '') }
        : { en: `${needs.length} in use, all working`, zh: `在用 ${needs.length} 个，都正常` },
    }]
  }
  /** Resolves once dsh's credential store is there (a product's migration waits for it at startup). */
  service.ready = async () => {
    for (let i = 0; i < 60 && !store; i++) await new Promise(r => setTimeout(r, 250))
    if (!store) throw coded('noCredentials', {}, 'dsh\'s credential store is not loaded')
  }
  ctx.provide?.('connectors', service)
  // One of Ruyix's parts: its step on the Get started page (the connections the products need, and what is wrong with them)
  ctx.inject?.(['ruyixShell'], inner => inner.effect(() => inner.ruyixShell?.part?.({ id: 'connectors', name: { en: 'Connectors', zh: '连接器' }, panel: 'connectors', order: 15, setup: () => service.setup() }), 'connectors: ruyix part'))

  // what an import left (ruyix config import, a box's first start), then every connection tested once, then hourly
  ctx.effect?.(() => {
    let stopped = false
    const timer = setInterval(() => { if (store) service.testAll() }, HOUR)
    setTimeout(async () => {
      for (let i = 0; i < 20 && !store && !stopped; i++) await new Promise(r => setTimeout(r, 500))
      if (stopped || !store) return
      const report = await service.takeImport().catch(err => { ctx.logger?.warn?.(`connectors: import: ${err.message}`); return null })
      if (report?.length) ctx.logger?.info?.(`connectors: imported ${report.filter(r => r.ok).length} of ${report.length} connections`)
      await service.testAll()
    }, 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, 'connectors: tests')

  const ops = {
    async list() { return { connections: await service.list(), types: service.types(), needs: service.needs(), inBox: service.inBox } },
    save: ({ connection }) => service.save(connection || {}),
    remove: ({ id }) => service.remove(String(id)).then(() => ({})),
    setSlot: ({ id, slot, value }) => service.setSlot(String(id), String(slot), value).then(() => service.test(String(id))),
    clearSlot: ({ id, slot }) => service.clearSlot(String(id), String(slot)).then(() => ({})),
    test: ({ id }) => service.test(String(id)),
    testAll: () => service.testAll().then(() => ({})),
    attention: () => ({ items: service.attention(), types: Object.fromEntries(service.types().map(t => [t.id, t.label])) }),
    audit: ({ id, limit }) => ({ entries: service.audit(id ? String(id) : '', Math.min(Number(limit) || 100, 500)) }),
    async signinStart({ id, attempt }) {
      // the type's `begin` makes the address to open (an OAuth authorize page) and the sign-in's private state, which stays in the service
      const c = service.get(String(id))
      return signin.start(c.id, null, null, { attempt, prepare: () => service.beginSignin(c.id) })
    },
    signinState: ({ since, id, attempt }) => signin.state({ since: Number(since), id, attempt }),
    signinInput: input => signin.input(input),
    signinStop: owner => signin.stop(owner),
    // sign in by a code to scan (OAuth device code: Baidu Netdisk)
    deviceStart: ({ id }) => service.deviceStart(String(id)),
    devicePoll: ({ id }) => service.devicePoll(String(id)),
  }
  ctx.connection.fetch.register({
    path: '/api/connectors',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        const { op, ...args } = await request.json()
        if (!Object.hasOwn(ops, op)) return Response.json({ error: `unknown op ${op}` }, { status: 400 })
        return Response.json(await ops[op](args))
      } catch (err) {
        return Response.json({ error: err?.message || String(err), code: err?.code, params: err?.params }, { status: 500 })
      }
    },
  })

  // every AI session: what is connected and whether it works — never a value
  const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
  const textResult = { schema: { type: 'object', properties: { text: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: v.text }] }
  const line = c => `${c.id} (${c.typeLabel.en}) ${c.baseUrl || ''} — ${c.status ? (c.status.ok ? `working: ${c.status.detail}` : `not working: ${c.status.detail}`) : 'not tested'}; credentials ${c.slots.map(s => `${s.name} ${s.set ? 'set' : 'unset'}`).join(', ')}${c.usedBy.length ? `; used by ${c.usedBy.map(u => u.owner).join(', ')}` : ''}`
  const tools = [
    { name: 'connectors_list', description: 'The services this workbench is connected to (GitLab, Kubernetes, HTTP APIs…): each connection, its address, whether it works, which credentials are set (never a value) and who uses it. Adding or signing in is the user\'s, on the Connectors page.', parameters: schema({}), output: textResult,
      async execute() { const list = await service.list(); return { text: list.length ? list.map(line).join('\n') : 'No connectors yet (the Connectors page adds them).' } } },
    { name: 'connectors_test', description: 'Test one connection now (or every one without id): reaches the service with its credentials and says what came back.', parameters: schema({ id: { type: 'string' } }), output: textResult,
      async execute({ id }) {
        if (id) { const s = await service.test(id); return { text: `${id}: ${s.ok ? 'working' : 'not working'} — ${s.detail}` } }
        await service.testAll()
        return { text: (await service.list()).map(line).join('\n') }
      } },
  ]
  const equipped = new Map()
  const equip = agent => {
    if (equipped.has(agent) || !agent?.ctx?.tools) return
    const off = tools.map(t => agent.ctx.tools.register(t))
    equipped.set(agent, () => off.forEach(d => d?.()))
  }
  for (const agent of ctx.agents?.list?.() || []) equip(agent)
  ctx.on?.('agent/created', ({ agent }) => equip(agent))
  ctx.on?.('agent/disposed', ({ agent }) => { equipped.get(agent)?.(); equipped.delete(agent) })
  ctx.effect?.(() => () => { for (const d of equipped.values()) d(); equipped.clear() }, 'connectors: assistant tools')
}
