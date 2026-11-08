// Self-check of the board schema, the built-in presets and the renderer's build (no network): node check.mjs
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { ACTIONS, OPS, canonical, check, derive, historyPoint, renderParams, satisfies, shapeRows, stateOf, validateDashboard, validateDataset, validateLayout, validateWorkspace } from './schema.js'
import { DASHBOARDS, DATASETS, SAMPLES, WORKSPACES } from './presets.js'

// the built-ins are valid, and every dashboard derives from its samples
for (const d of Object.values(DATASETS)) assert.deepEqual(validateDataset(d), { ok: true, errors: [] }, d.name)
for (const d of Object.values(DATASETS)) assert.ok(Object.keys(d.fields).every(k => k in OPS[d.connector][d.op].fields), d.name)
for (const b of Object.values(DASHBOARDS)) {
  const r = check(b, { datasets: DATASETS, samples: SAMPLES })
  assert.deepEqual(r.errors, [], b.name)
  assert.equal(r.pages[0].widgets.find(w => w.id === 'red-mrs').value, 1) // a filter on a field
}

// the logic below runs on a made-up connector type (a tracker's issues and bugs): the built-ins name only gitlab and k8s
OPS.demo = {
  'issues.list': { params: { project: 'string', query: 'string', period: 'string', limit: 'number' },
    fields: { id: 'string', project: 'string', title: 'string', culprit: 'string', level: 'enum', status: 'enum', events: 'number', users: 'number', first: 'time', last: 'time', url: 'url' } },
  'bugs.list': { params: { project: 'number', status: 'string[]', limit: 'number' }, fields: { id: 'string', summary: 'string', status: 'enum' } },
}
const t2 = (zh, en) => ({ zh, en })
const DEMO = {
  kind: 'dataset', name: 'demo-issues', version: '1.0.0', title: t2('线上错误', 'Production errors'),
  connector: 'demo', op: 'issues.list',
  params: { project: '{{settings.demo.project}}', query: 'is:unresolved environment:{{settings.demo.environment}}', period: '24h', limit: 500 },
  fields: { id: 'string', project: 'string', title: 'string', level: 'enum', status: 'enum', events: 'number', users: 'number', first: 'time', last: 'time', url: 'url' },
  labels: { project: t2('服务', 'Service'), title: t2('错误', 'Error') },
  key: 'id', refresh: '10m', history: { keep: ['count', 'events'], days: 30 },
}
const DEMO_ROWS = [
  { id: '101', project: 'api', title: 'TimeoutError: upstream did not answer', level: 'error', status: 'unresolved', events: 42, users: 7, first: '2026-10-11T08:00:00Z', last: '2026-10-12T09:30:00Z', url: 'https://errors.example/101' },
  { id: '102', project: 'worker', title: 'KeyError: missing field', level: 'warning', status: 'unresolved', events: 3, users: 1, first: '2026-10-12T07:00:00Z', last: '2026-10-12T07:10:00Z', url: 'https://errors.example/102' },
]
const DEMO_BOARD = {
  kind: 'dashboard', name: 'demo-health', version: '1.0.0', title: t2('线上健康', 'Production health'), renderer: '>=1',
  datasets: { sentry: 'demo-issues@^1' },
  pages: [{ id: 'overview', title: t2('概览', 'Overview'), widgets: [
    { id: 'issues', data: 'sentry', view: 'count', size: 's', title: t2('未解决的错误', 'Unresolved errors') },
    { id: 'events', data: 'sentry', view: 'trend', value: 'events', size: 's', title: t2('错误事件', 'Error events') },
    { id: 'issues-by-service', data: 'sentry', view: 'breakdown', by: 'project', value: 'events', size: 'm', title: t2('按服务', 'By service') },
    { id: 'top-issues', data: 'sentry', view: 'table', columns: ['project', 'title', 'level', 'events', 'users', 'last'], sort: '-events', limit: 10, size: 'l', title: t2('最多的错误', 'Top errors'),
      actions: [{ op: 'url.open', args: { url: '$row.url' }, label: t2('打开', 'Open') }] },
  ] }],
}
const DS = { ...DATASETS, 'demo-issues': DEMO }
assert.deepEqual(check(DEMO_BOARD, { datasets: DS, samples: { 'demo-issues': DEMO_ROWS } }).errors, [])
for (const w of Object.values(WORKSPACES)) assert.deepEqual(validateWorkspace(w).errors, [], w.name)
for (const w of Object.values(WORKSPACES)) for (const ref of w.dashboards) assert.ok(DASHBOARDS[ref.split('@')[0]], ref)

// what a publish must refuse
const ds = DEMO
const codes = d => validateDataset(d).errors.map(e => e.code)
assert.deepEqual(codes({ ...ds, op: 'issues.delete' }), ['op'])
assert.deepEqual(codes({ ...ds, script: 'x@1' }), ['producer'])
assert.deepEqual(codes({ ...ds, fields: { ...ds.fields, stack: 'string' } }), ['notOffered'])
assert.deepEqual(codes({ ...ds, params: { ...ds.params, token: 'x' } }), ['param'])
assert.deepEqual(codes({ ...ds, refresh: '30s' }), ['refresh'])
assert.deepEqual(codes({ ...ds, connector: undefined, op: undefined, agent: { skill: 'x' } }), ['notYet'])
const board = DEMO_BOARD, w0 = board.pages[0].widgets
const bcodes = b => validateDashboard(b, { datasets: DS }).errors.map(e => e.code)
const withWidget = w => ({ ...board, pages: [{ ...board.pages[0], widgets: [...w0, w] }] })
assert.deepEqual(bcodes(withWidget({ id: 'x', data: 'sentry', view: 'list', columns: ['culprit'] })), ['field'])
assert.deepEqual(bcodes(withWidget({ id: 'x', data: 'sentry', view: 'list', actions: [{ op: 'run.delete', args: {} }] })), ['action'])
assert.deepEqual(bcodes(withWidget({ id: 'x', data: 'sentry', view: 'list', actions: [{ op: 'url.open', args: { url: '$row.nope' } }] })), ['arg'])
assert.deepEqual(bcodes(withWidget({ id: 'x', data: 'nope', view: 'count' })), ['data'])
assert.deepEqual(bcodes(withWidget({ id: 'issues', data: 'sentry', view: 'count' })), ['dup'])
assert.deepEqual(bcodes({ ...board, renderer: '>=2' }), ['rendererNewer'])
assert.deepEqual(Object.keys(ACTIONS), ['run.open', 'url.open'])
assert.deepEqual(validateLayout({ home: 'core/overview', dashboards: ['dev-overview@1.0.0', { local: 'x' }], apps: ['notes'], preset: 'studio@1.0.0', at: 1, by: 'm' }).errors, [])
assert.deepEqual(validateLayout({ dashboards: ['dev-overview@^1'], preset: 'studio' }).errors.map(e => e.code), ['ref', 'preset'])

// versions
for (const [v, r, want] of [['1.2.3', '1.2.3', true], ['1.2.3', '^1', true], ['2.0.0', '^1', false], ['1.2.3', '^1.3', false], ['1.3.0', '^1.2', true], ['1.2.9', '~1.2', true],
  ['1.3.0', '~1.2', false], ['1.2.3', '>=1', true], ['0.9.0', '>=1', false], ['1.0.0', '*', true], ['1.4.0', '1.x', true], ['1.2.2', '^1.2.3', false]]) assert.equal(satisfies(v, r), want, `${v} ${r}`)

// params from settings: a whole-value hole keeps its type, an unset one is null
assert.deepEqual(renderParams({ project: '{{settings.k8s.project}}', q: 'env:{{settings.env}}', n: 5, miss: '{{settings.none}}' }, { k8s: { project: 'p1' }, env: 'prod' }),
  { project: 'p1', q: 'env:prod', n: 5, miss: null })

// rows leave the node as the dataset says: its fields only, of its types, no email or address
const sh = shapeRows([{ id: '1', title: 'fail for a.b@c.com from 10.1.2.3', level: 'error', status: 'x', events: '7', users: 1, first: 'nope', last: '2026-10-12T00:00:00Z', url: 'u', stack: 'secret' }], ds)
assert.equal(sh.rows[0].title, 'fail for <email> from <ip>')
assert.equal(sh.rows[0].events, null)
assert.equal(sh.rows[0].first, null)
assert.ok(!('stack' in sh.rows[0]))
assert.deepEqual(sh.bad.map(b => b.field), ['events', 'first'])
assert.equal(canonical([{ b: 1, a: 2 }], { fields: { a: 'number', b: 'number' } }), canonical([{ a: 2, b: 1 }], { fields: { b: 'number', a: 'number' } }))
assert.deepEqual(historyPoint(DEMO_ROWS, ds, 5), { at: 5, count: 2, events: 45 })

// what a widget shows
const rows = DEMO_ROWS
// The exported renderer's row actions may use a declared dataset field that is not a visible column.
{
  const row = { id: '1', title: 'Issue', url: 'https://fixture.invalid/1' }
  const widget = { view: 'table', columns: ['title'], actions: [{ op: 'url.open', args: { url: '$row.url' } }] }
  assert.deepEqual(derive([row], widget).rows[0], { title: 'Issue', url: row.url }, 'action argument survives the visible-column projection')
}
assert.equal(derive(rows, { view: 'count' }).value, 2)
assert.equal(derive(rows, { view: 'count', filter: { level: 'error' } }).value, 1)
assert.equal(derive(rows, { view: 'count', filter: { events: { min: 10 } } }).value, 1)
assert.deepEqual(derive(rows, { view: 'breakdown', by: 'level', value: 'events' }).groups, [{ key: 'error', count: 42 }, { key: 'warning', count: 3 }])
assert.deepEqual(derive(rows, { view: 'list', sort: 'events', limit: 1, columns: ['id'] }), { rows: [{ id: '102' }], total: 2 })
assert.deepEqual(derive(rows, { view: 'list', sort: '-last', columns: ['id'] }).rows.map(r => r.id), ['101', '102'])
assert.equal(derive(rows, { view: 'count', filter: { last: { since: '1h' } } }, { now: Date.parse('2026-10-12T10:00:00Z') }).value, 1)
assert.deepEqual(derive([], { view: 'trend', value: 'events' }, { history: [{ at: 1, events: 3 }, { at: 2, events: 5 }] }).points, [{ at: 1, value: 3 }, { at: 2, value: 5 }])

// the five states
const now = 1e9, ok = { at: now - 60e3, count: 2, rows }
assert.equal(stateOf(null, ds, { now, denied: true }).state, 'denied')
assert.equal(stateOf(null, ds, { now }).state, 'loading')
assert.equal(stateOf(null, ds, { now, unset: true }).state, 'unset')
assert.deepEqual(codes({ ...ds, labels: { stack: { zh: 'x', en: 'x' } } }), ['label'])
assert.equal(stateOf({ last: { at: now, status: 'failed', error: 'x' } }, ds, { now }).state, 'error')
assert.equal(stateOf({ ok: { ...ok, count: 0 }, last: { at: now, status: 'ok' } }, ds, { now }).state, 'empty')
assert.equal(stateOf({ ok: { ...ok, at: now - 30 * 60e3 } }, ds, { now }).state, 'stale') // refresh 10m
assert.deepEqual(stateOf({ ok, last: { at: now, status: 'too_large' } }, ds, { now }), { state: 'ok', at: ok.at, age: 60e3, failed: { status: 'too_large', error: '', at: now } })

// a run where the credentials are: params from settings, rows cut and hashed, kept on disk with their history
{
  const { runDataset, snapshotStore, due, MAX_BYTES } = await import('./run.js')
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const asked = []
  const read = async (conn, op, params) => { asked.push([conn, op, params]); return DEMO_ROWS.map(r => ({ ...r, stack: 'x' })) }
  let t = 1000
  const ok = await runDataset(ds, { read, connection: 'se', settings: { demo: { project: 'web', environment: 'production' } }, now: () => (t += 5) })
  assert.deepEqual(asked[0], ['se', 'issues.list', { project: 'web', query: 'is:unresolved environment:production', period: '24h', limit: 500 }])
  assert.deepEqual([ok.status, ok.count, ok.hash.length, 'stack' in ok.rows[0], ok.tookMs], ['ok', 2, 64, false, 5])
  assert.match((await runDataset(ds, { read, connection: 'se', settings: {} })).error, /demo.project is not set/)
  assert.equal((await runDataset(ds, { read: async () => { throw new Error('HTTP 401') }, connection: 'se', settings: { demo: { project: 'w', environment: 'p' } } })).status, 'failed')
  const big = await runDataset(ds, { read: async () => Array.from({ length: 3000 }, (_, i) => ({ id: String(i), title: 'x'.repeat(800) })), connection: 'se', settings: { demo: { project: 'w', environment: 'p' } } })
  assert.deepEqual([big.status, 'rows' in big, MAX_BYTES], ['too_large', false, 2097152])
  const store = snapshotStore(join(mkdtempSync(join(tmpdir(), 'board-snap-')), 'snaps'))
  store.put(ds, ok)
  const kept = store.put(ds, { ...ok, at: ok.at + 60e3, status: 'failed', error: 'HTTP 502', rows: undefined })
  assert.deepEqual([kept.ok.count, kept.last.status, kept.history.length, kept.history[0].events], [2, 'failed', 1, 45], 'a failed run keeps the last good rows')
  assert.equal(stateOf(kept, ds, { now: ok.at + 120e3 }).failed.status, 'failed')
  assert.ok(due(ds, null) && !due(ds, kept, { now: ok.at + 61e3 + 60e3 }) && due(ds, kept, { now: ok.at + 61e3 + 600e3 }) && due(ds, kept, { now: ok.at + 70e3, asked: ok.at + 65e3 }))
}

// the renderer builds (React stays the host's), and says the same things in both languages
const stub = { name: 'react-stub', setup(b) { b.onResolve({ filter: /^react(\/|$)/ }, a => ({ path: a.path, namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const jsx = () => null, jsxs = jsx, Fragment = null, useMemo = f => f(), useState = v => [v, () => {}]' })) } }
const out = await build({ entryPoints: ['Board.jsx'], bundle: true, write: false, format: 'esm', jsx: 'automatic', plugins: [stub], logLevel: 'silent' })
const { BOARD_TEXT, Board } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
assert.equal(typeof Board, 'function')
{ // a dataset's literal params are of their read's types (a whole {{settings.…}} stands for one)
  const { validateDataset } = await import('./schema.js')
  const ds = params => ({ kind: 'dataset', name: 'm-1', version: '1.0.0', connector: 'demo', op: 'bugs.list', params, fields: { id: 'string' }, refresh: '10m' })
  assert.ok(validateDataset(ds({ project: 1, status: 'open' })).errors.some(e => e.code === 'paramType'), 'status is a string[]')
  assert.ok(!validateDataset(ds({ project: 3, status: ['{{settings.demo.status}}'] })).errors.length, 'a setting inside a list')
  assert.ok(validateDataset(ds({ project: 3, status: '{{settings.demo.status}}' })).errors.some(e => e.code === 'paramType'), 'a setting is text: never a whole list')
  assert.ok(validateDataset(ds({ project: '{{settings.demo.project}}' })).errors.some(e => e.code === 'paramType'), 'nor a number')
}
{ // a filter is what matchRow reads — an object that only looks like a value is refused; connector names are strings
  const { validateDashboard, validateDataset } = await import('./schema.js')
  const d = JSON.parse(JSON.stringify(DEMO_BOARD)), w = d.pages[0].widgets.find(x => x.data === 'sentry')
  w.filter = { level: [{ toString: 'x', valueOf: null }] }
  assert.ok(validateDashboard(d, { datasets: DS }).errors.some(e => e.code === 'filterValue'))
  w.filter = { level: ['error', 'fatal'], events: { min: 3 }, last: { since: '24h' }, title: { has: 'Type' } }
  assert.ok(!validateDashboard(d, { datasets: DS }).errors.some(e => e.code === 'filterValue'))
  w.filter = { events: { min: 'a lot' } }
  assert.ok(validateDashboard(d, { datasets: DS }).errors.some(e => e.code === 'filterValue'))
  assert.ok(validateDataset({ ...DEMO, connector: ['demo'] }).errors.some(e => e.code === 'connector'), 'a connector named by a list')
  assert.ok(validateDataset({ ...DEMO, params: null }).errors.some(e => e.code === 'params'), 'params: an object')
}
{ // an action's label is words, both languages: an object there would be a React child on the board
  const { validateDashboard } = await import('./schema.js')
  const d = JSON.parse(JSON.stringify(DEMO_BOARD)), w = d.pages.flatMap(p => p.widgets).find(x => x.actions?.length)
  w.actions[0].label = { en: { bad: 'object' }, zh: 'x' }
  assert.ok(validateDashboard(d, { datasets: DS }).errors.some(e => e.code === 'label'), 'a label that is no words')
  w.actions[0].label = { en: 'Open it', zh: '打开' }
  assert.ok(!validateDashboard(d, { datasets: DS }).errors.some(e => e.code === 'label'))
}
const keys = o => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v).map(x => `${k}.${x}`) : [k])).sort()
assert.deepEqual(keys(BOARD_TEXT.zh), keys(BOARD_TEXT.en))


{ // a board from a conversation (inline.js): its data in hand; what does not check says what to change
  const { inlineBoard } = await import('./inline.js')
  const ok = inlineBoard({ title: 'Bugs', data: { bugs: { fields: { id: 'string', sev: 'enum', at: 'time', n: 'number' }, rows: [{ id: '1', sev: 'S1', at: '2026-10-02', n: 3 }, { id: '2', sev: 'S2', at: '2026-10-01', n: 5 }] } },
    widgets: [{ view: 'count', data: 'bugs' }, { view: 'breakdown', data: 'bugs', by: 'sev' }, { view: 'table', data: 'bugs', columns: ['id'] }, { view: 'trend', data: 'bugs', value: 'n' }, { view: 'note', text: 'x' }] })
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.history['ui-bugs'].map(p => p.n), [5, 3], 'a trend\'s points by their time')
  assert.equal(ok.snapshots['ui-bugs'].ok.count, 2)
  assert.equal(derive(ok.snapshots['ui-bugs'].ok.rows, ok.spec.pages[0].widgets[1]).groups.length, 2)
  const bad = inlineBoard({ data: { Bugs: { fields: { a: 'weird' }, rows: 'x' }, b: { fields: { x: 'string' }, rows: [] } }, widgets: [{ view: 'runs', data: 'b' }, { view: 'breakdown', data: 'b' }, { view: 'table', data: 'b', columns: ['nope'] }, { view: 'trend', data: 'b' }] })
  assert.deepEqual(bad.errors.map(e => e.path), ['data.Bugs', 'widgets.0.view', 'widgets.3', 'widgets.1.by', 'widgets.2.columns'])
  assert.deepEqual(inlineBoard(null).errors.map(e => e.path), ['widgets'])
  // what a model may send instead: shaped, never thrown (an object in a cell, columns as a map, actions, labels of objects)
  const odd = inlineBoard({ data: { a: { fields: { x: 'string' }, labels: { x: { en: 'X' }, y: { deep: 1 } }, rows: [{ x: { deep: 1 } }] } }, widgets: [{ view: 'table', data: 'a', columns: { id: 'ID' }, actions: 'open', filter: 'x' }] })
  assert.deepEqual(odd.errors.map(e => e.path), ['widgets.0.columns', 'widgets.0.filter'])
  assert.equal(odd.snapshots['ui-a'].ok.rows[0].x, '{"deep":1}')
  assert.deepEqual(odd.datasets['ui-a'].labels, { x: { zh: 'X', en: 'X' } })
  assert.equal(odd.spec.pages[0].widgets[0].actions, undefined)
  // a row of many properties keeps the declared fields (a widget sums them)
  const wide = Object.fromEntries([...Array.from({ length: 45 }, (_, i) => [`x${i}`, i]), ['n', 7]])
  const many = inlineBoard({ data: { a: { fields: { n: 'number' }, rows: [wide] } }, widgets: [{ view: 'count', data: 'a', value: 'n' }] })
  assert.equal(derive(many.snapshots['ui-a'].ok.rows, many.spec.pages[0].widgets[0]).value, 7)
  // a declared field named as an object's own (constructor) that a row leaves out: nothing, not a crash
  const named = inlineBoard({ data: { a: { fields: { constructor: 'string', n: 'number' }, rows: [{ n: 1 }] } }, widgets: [{ view: 'table', data: 'a' }] })
  assert.deepEqual([named.errors, named.snapshots['ui-a'].ok.rows], [[], [{ n: 1 }]])
  assert.ok(inlineBoard({ data: { a: { fields: {}, rows: Array.from({ length: 301 }, () => ({})) } }, widgets: [{ view: 'count', data: 'a' }] }).errors.some(e => /300 rows/.test(e.message)))
}

console.log('board check ok')

// Invalid dates from an inline board render their raw value rather than taking the whole board down.
{
  const { readFileSync } = await import('node:fs'), { transformSync } = await import('esbuild')
  const src = readFileSync(new URL('./Board.jsx', import.meta.url), 'utf8').match(/function Cell[\s\S]*?\n}/)[0]
  const code = transformSync(src, { loader: 'jsx' }).code
  const Cell = new Function('React', code + '; return Cell')({ createElement: (type, props) => ({ type, props }) })
  assert.equal(Cell({ type: 'time', value: '10月20日', T: {} }), '10月20日')
  assert.equal(Cell({ type: 'time', value: 1e30, T: {} }), '1e+30')
  assert.equal(Cell({ type: 'time', value: 0, T: {} }).type, 'time')
}
