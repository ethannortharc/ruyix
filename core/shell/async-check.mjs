// Execute the actual hook bodies with controlled responses and clocks: old replies must not change the current view.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openRegistry } from './src/open.js'
import { recordPatch } from '../plugins/studio/src/record-patch.js'
import { emptyOpen, applyOpen } from './open-model.js'
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8')
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const clock = () => {
  let now = 0, n = 0; const jobs = new Map()
  return { setTimeout(fn, ms) { jobs.set(++n, { at: now + ms, fn }); return n }, clearTimeout(id) { jobs.delete(id) },
    async advance(ms) { const end = now + ms; for (;;) { const next = [...jobs].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; jobs.delete(next[0]); next[1].fn(); await tick() } now = end; await tick() } }
}
function hooks() {
  const slots = []; let cursor = 0, effects = [], dirty = false
  const useRef = v => { const i = cursor++; return slots[i] ||= { current: v } }
  const useState = v => { const i = cursor++; if (!slots[i]) slots[i] = { value: typeof v === 'function' ? v() : v }; return [slots[i].value, x => { slots[i].value = typeof x === 'function' ? x(slots[i].value) : x; dirty = true }] }
  const useEffect = (fn, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) { effects.push(() => { old?.clean?.(); slots[i] = { deps, clean: fn() } }) } }
  const useCallback = (fn, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) slots[i] = { deps, fn }; return slots[i].fn }
  return { useRef, useState, useEffect, useCallback, render(fn) { let out; do { dirty = false; cursor = 0; effects = []; out = fn(); for (const effect of effects) effect() } while (dirty); return out } }
}
// A delayed page from filter A cannot leak into B, including after a subsequent refresh.
{
  const h = hooks(), calls = [], src = read('./src/tasks/data.js')
  const body = src.slice(src.indexOf('function usePaged('), src.indexOf('export function useTaskList'))
  const usePaged = new Function(...Object.keys(h).filter(k => k !== 'render'), 'useFresh', 'op', 'PAGE', body + '; return usePaged')(...Object.values(h).slice(0, 4), () => {}, (_name, args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise }, 40)
  let filter = { q: 'A' }; const draw = () => h.render(() => usePaged('list', filter, 'id', r => r.rows))
  let view = draw(); calls[0].resolve({ rows: [{ id: 'A1' }], more: true }); await tick(); view = draw()
  const more = view.loadMore(); filter = { q: 'B' }; draw(); calls[2].resolve({ rows: [{ id: 'B1' }] }); await tick()
  calls[1].resolve({ rows: [{ id: 'A2' }] }); await more
  view = draw(); assert.deepEqual(view.list.map(x => x.id), ['B1'])
  const reload = view.reload(); calls[3].resolve({ rows: [{ id: 'B1' }] }); await reload
  assert.deepEqual(draw().list.map(x => x.id), ['B1'])
}

// Records has its own pager: late pages from an old filter must obey the same ownership guard.
{
  const h=hooks(), c=clock(), calls=[],src=read('../workbench/src/records.jsx')
  const body=src.slice(src.indexOf('export function RecordsView(')+7,src.indexOf('  const words =',src.indexOf('export function RecordsView(')))+';return {data,more,setQ} };return RecordsView'
  const fn=new Function('useState','useRef','useEffect','useT','local','GROUPS','KINDS','PAGE','call','errorText','setTimeout','clearTimeout','setInterval','clearInterval',body)(h.useState,h.useRef,h.useEffect,()=>x=>x,{get:(_k,d)=>d,set:()=>{}},['day'],['run'],40,(_op,args)=>{const d=deferred();calls.push({...d,args});return d.promise},(_t,e)=>e.message,c.setTimeout,c.clearTimeout,()=>1,()=>{})
  const draw=()=>h.render(()=>fn({toast:()=>assert.fail('no current request failed')}))
  draw();await c.advance(0);calls[0].resolve({items:[{id:'old1',at:2}],more:true});await tick()
  let view=draw();const older=view.more();view.setQ('new');draw();await c.advance(250)
  calls[2].resolve({items:[{id:'new1',at:4}],more:false});await tick();calls[1].resolve({items:[{id:'old2',at:1}],more:false});await older
  assert.deepEqual(draw().data.items.map(x=>x.id),['new1'])
}
// Traffic and Timeline may resolve in either order; only the current filter's latest request wins.
for (const name of ['Traffic', 'Timeline']) {
  const h = hooks(), c = clock(), calls = [], src = read('../plugins/box/src/main.jsx')
  const start = src.indexOf(`function ${name}(`), end = src.indexOf('  return (', start)
  const body = src.slice(start, end) + '; return { rows, load, ' + (name === 'Traffic' ? 'setHost' : 'setText') + ' } }'
  const fn = new Function(...Object.keys(h).filter(k => k !== 'render'), 'call', 'setTimeout', 'clearTimeout', 'local', 'errText', body + `; return ${name}`)(...Object.values(h).slice(0, 4), (_name, args) => { const d = deferred(); calls.push({ ...d, args }); return d.promise }, c.setTimeout, c.clearTimeout, { get: () => [] }, (_t, e) => e.message)
  const draw = () => h.render(() => fn({ t: x => x, setError: e => { throw new Error(e) } }))
  let view = draw(); await c.advance(250)
  const setter = view.setHost || view.setText; setter('githu'); draw(); await c.advance(250)
  setter(''); draw(); await c.advance(250)
  calls[2].resolve([{ id: 'current' }]); await tick(); calls[1].resolve([{ id: 'stale' }]); calls[0].resolve([{ id: 'old' }]); await tick()
  assert.deepEqual(draw().rows, [{ id: 'current' }])
}
// New notes typed during an external write stay pending, and a failed POST is retried.
{
  const h = hooks(), c = clock(), heard = {}, src = read('./src/desktop/widgets.jsx')
  const start = src.indexOf('function NoteW('), end = src.indexOf('  return <textarea', start)
  let server = 'initial', failures = 1
  const fetch = async (_url, options) => {
    if (options?.method === 'POST') { if (failures--) return { ok: false, status: 500 }; server = JSON.parse(options.body).text }
    return { ok: true, json: async () => ({ notes: { n1: server } }) }
  }
  const win = { addEventListener: (k, fn) => { heard[k] = fn }, removeEventListener() {} }
  const body = 'let notesCache = null; const loadNotes = () => (notesCache ||= fetch("notes").then(r => r.json()).then(j => j.notes));\n' + src.slice(start, end) + '; return { v, change, error } }; return NoteW'
  const fn = new Function(...Object.keys(h).filter(k => k !== 'render'), 'fetch', 'window', 'setTimeout', 'clearTimeout', body)(...Object.values(h).slice(0, 4), fetch, win, c.setTimeout, c.clearTimeout)
  const draw = () => h.render(() => fn({ id: 'n1', T: {}, preview: false }))
  draw(); await tick(); let view = draw(); view.change({ target: { value: 'typed' } }); draw()
  server = 'agent edit'; heard['ruyix:notes']({ detail: { id: 'n1' } }); await tick()
  assert.equal(draw().v, 'typed')
  await c.advance(600); assert.equal(draw().error, true); assert.equal(server, 'agent edit')
  await c.advance(1500); view = draw(); assert.equal(view.v, server); assert.equal(server, 'typed'); assert.equal(view.error, false)
}
// Rapid link updates don't cancel the earlier animation's removal.
{
  const h = hooks(), c = clock(), src = read('./src/desktop/collab.jsx')
  const start = src.indexOf('  const timers = useRef'), end = src.indexOf('  const [pick,', start)
  const run = new Function('useRef', 'useState', 'useEffect', 'setTimeout', 'clearTimeout', 'links', 'at', 'reduced', 'keyOf', 'curve', 'mid', 'agentColor', 'nodes', src.slice(start, end) + '; return flights')
  let links = []; const draw = () => h.render(() => run(h.useRef, h.useState, h.useEffect, c.setTimeout, c.clearTimeout, links, { a: {}, b: {} }, () => false, x => x.id, () => '', {}, () => '', []))
  draw(); links = [{ id: '1', from: 'a', to: 'b' }]; draw(); await c.advance(500)
  links = [...links, { id: '2', from: 'b', to: 'a' }]; assert.equal(draw().length, 2)
  await c.advance(2000); assert.equal(draw().length, 0)
}


// Card side effects have one owner; late completions cannot overwrite a later dismissal, and partial edits stay explicit.
{
  const src=read('../workbench/lib/assistant.js'), rows=new Map([1,2,3,4].map(n=>[n,{n,kind:n===2?'runop':'draft',thread:'main'}])), runs=[]
  const conv={get:n=>rows.get(n),set:(n,v)=>(rows.set(n,v),v)}, store={list:k=>k==='run'?runs:[]}
  const body=src.slice(src.indexOf('  const cardActions ='),src.indexOf('  const self =',src.indexOf('  const cardActions =')))
  let serial=0;const action=new Function('conv','store','MAIN','now','randomUUID',body+';return cardAction')(conv,store,'main',()=>1,()=>String(++serial))
  const gate=deferred();let calls=0
  const first=action(1,'draft',async()=>{calls++;await gate.promise;return {outcome:{status:'started',run:'r'}}})
  const second=action(1,'draft',()=>assert.fail('duplicate start'))
  gate.resolve();await first;await second;assert.equal(calls,1);assert.equal(rows.get(1).outcome.run,'r')
  await assert.rejects(action(1,'draft',()=>{}),e=>e.code==='cardDone')
  await assert.rejects(action(2,'runop',async item=>{conv.set(2,{...conv.get(2),effect:{version:'saved'}});throw new Error('continue failed')}),/continue failed/)
  assert.equal(rows.get(2).outcome.status,'partial');assert.equal(rows.get(2).outcome.result.version,'saved');assert.equal(rows.get(2).acting,null)
  conv.set(3,{...rows.get(3),acting:{id:'old'}});runs.push({id:'recovered',tags:['chat:3']})
  assert.equal((await action(3,'draft',()=>assert.fail('do not repeat an already-created run'))).run.id,'recovered')
  const late=deferred(),pending=action(4,'draft',async()=>{await late.promise;return {outcome:{status:'started',run:'late'}}})
  conv.set(4,{...rows.get(4),acting:null,outcome:{status:'dismissed'}});late.resolve()
  await assert.rejects(pending,e=>e.code==='cardDone');assert.equal(rows.get(4).outcome.status,'dismissed')
}

// A late results reload cannot hide a comment acknowledged by a newer reload.
{
  const h=hooks(), calls=[],src=read('../workbench/src/results.jsx')
  const body=src.slice(src.indexOf('export function useResults(')+7,src.indexOf('export function ResultsTab'))
  const fn=new Function('useState','useRef','useEffect','call',body+';return useResults')(h.useState,h.useRef,h.useEffect,()=>{const d=deferred();calls.push(d);return d.promise})
  const draw=()=>h.render(()=>fn({id:'r',updatedAt:1,status:'done'}))
  draw();calls[0].resolve({comments:[]});await tick();const reload=draw()[1]
  const old=reload(),fresh=reload();calls[2].resolve({comments:[{id:'new'}]});await fresh;calls[1].resolve({comments:[]});await old
  assert.equal(draw()[0].comments[0].id,'new')
}
// A refresh during debounce and an older save's reply must both preserve the latest comment edit.
{
  const h = hooks(), c = clock(), src = read('../workbench/src/viewer.jsx'), calls = []
  const body = src.slice(src.indexOf('export function useSaved(') + 7, src.indexOf('// ── text:'))
  const fn = new Function('useState', 'useRef', 'useCallback', 'useEffect', 'useT', 'errorText', 'setTimeout', 'clearTimeout', body + '; return useSaved')(h.useState, h.useRef, h.useCallback, h.useEffect, () => x => x, (_t,e) => e.message, c.setTimeout, c.clearTimeout)
  const save = (list, revision) => { const d = deferred(); calls.push({ ...d, list, revision }); return d.promise }
  const draw = () => h.render(() => fn([], save, "r0"))
  let v = draw(); v.change([{ id: 'c1', text: 'first' }]); draw().reset([]); assert.equal(draw().comments[0].text, 'first')
  await c.advance(500); draw().change([{ id: 'c1', text: 'newer' }]); calls[0].resolve({comments:[{ id: 'c1', text: 'first' }],revision:'r1'}); await tick()
  assert.equal(draw().comments[0].text, 'newer')
  await c.advance(500); assert.equal(calls[1].list[0].text, 'newer'); assert.equal(calls[1].revision,'r1'); calls[1].resolve({comments:calls[1].list,revision:'r2'}); await tick()
  draw().change([{ id:'c1', text:'not saved' }]); const flush = draw().flush(); await tick(); calls[2].reject(new Error('cannot save'))
  await assert.rejects(flush, /cannot save/); draw().reset([]); assert.equal(draw().comments[0].text, 'not saved')
}

// Concurrent questions use separate tokens; finishing one cannot revoke the other's tools or session scope.
{
  const { randomUUID } = await import('node:crypto'), src=read('../workbench/lib/engine.js'), tokens=new Map(), jobs=[]
  const mcpBody=src.slice(src.indexOf('  const mcpFor ='),src.indexOf('  /** A step\'s agent has no business'))
  const mcpFor=new Function('tokens','randomUUID','mcp',mcpBody+';return mcpFor')(tokens,randomUUID,{name:'test',url:async()=>'',script:'bridge.mjs'})
  const body=src.slice(src.indexOf('  const answerQuestion ='),src.indexOf('  /**\n   * A discussion with the person'))
  const rows=new Map(['a','b'].map(id=>[id,{id,chat:[{n:1,q:id}]}])), store={get:(_k,id)=>rows.get(id),put:(_k,v)=>rows.set(v.id,v),evidence:()=>[]}
  const askAgent=async (run,stage,_role,_brief,{token})=>{await mcpFor(run,stage,token);const d=deferred();jobs.push({...d,token});return d.promise}
  const fn=new Function('store','workflowOf','chatBrief','get','askAgent','randomUUID','ASK_STAGE','tokens',body+';return answerQuestion')(store,()=>({roles:{writer:{}}}),()=>'',()=>({}),askAgent,randomUUID,'ask',tokens)
  const controller={signal:{aborted:false}}, def={key:'lane',owner:'writer'}
  const a=fn('r',def,rows.get('a'),{n:1,q:'a'},controller),b=fn('r',def,rows.get('b'),{n:1,q:'b'},controller);await tick()
  assert.equal(tokens.size,2);jobs[0].resolve({report:'A'});await a;assert.equal(tokens.has(jobs[1].token),true)
  jobs[1].resolve({report:'B'});await b;assert.equal(tokens.size,0)
  const taskMap=new Map([['ta','r'],['tb','r']]), sessions={ta:{sessionId:'sa'},tb:{sessionId:'sb'}}
  const scopeBody=src.slice(src.indexOf('    stageOfSession('),src.indexOf('    /** A tool call of an agent'))
  const scopes=new Function('get','hub','askTasks','ASK_STAGE',`return ({${scopeBody}})`)(()=>({stages:[],stage:'write'}),()=>({task:id=>sessions[id]}),taskMap,'ask')
  taskMap.delete('ta');assert.equal(scopes.stageOfSession('r','sb'),'ask')
}
// Each decision is settled only by the stage that requested it, independent of lane completion order.
{
  const src = read('../workbench/lib/engine.js'), rows = new Map([['a2', { id:'a2', runId:'r', action:'decision', status:'done', payload:{stage:'lane2'}, result:{option:{action:'revise',from:'lane2',label:'again'}} }]])
  const body = src.slice(src.indexOf('  const settleDecisions ='), src.indexOf('  // dsh going down mid-run'))
  const store = { list: () => [...rows.values()], put: (_kind, item) => rows.set(item.id, item) }
  const settle = new Function('store','update','workflowOf','sleep','settleMs', body + '; return settleDecisions')(store, () => {}, () => ({stages:[{key:'lane1'},{key:'lane2'}]}), () => assert.fail('no pending decisions'), 1)
  assert.equal(await settle('r','lane1',{aborted:false}), null); assert.ok(!rows.get('a2').result.applied)
  assert.equal((await settle('r','lane2',{aborted:false})).goto, 'lane2'); assert.equal(rows.get('a2').result.applied,true)
  assert.equal(rows.get('a2').applied,true,'shared review consumers also see the decision as consumed')
  rows.set('retired',{id:'retired',runId:'r',action:'decision',status:'done',applied:true,payload:{stage:'lane2'},result:{option:{action:'revise',from:'lane2',label:'stale'}}})
  assert.equal(await settle('r','lane2',{aborted:false}),null,'a superseded answered decision is never consumed again')
}
// Removal deltas clear both the badge's documents and its cached approval status.
{
  const src = read('../workbench/src/main.jsx'), start = src.indexOf('    const onDelta ='), end = src.indexOf('    // the counts for places', start)
  const seen = new Map(), runOf = new Map(), runs = new Map(), apps = new Map(), remindedOf = new Map(), badge = {value:{}}, ACTIVE = new Set(['running'])
  const bindings = {seen,runOf,runs,apps,remindedOf,badge,ACTIVE, notify:()=>{},t:x=>x, verdictText:()=>'', noticesOf:()=>[], unseen:()=>0, local:{get:()=>0},SEEN:'seen',setBadge:v=>{badge.value=v}}
  const delta = new Function(...Object.keys(bindings), src.slice(start,end)+'; return onDelta')(...Object.values(bindings))
  delta({first:true, docs:[{kind:'run',id:'r',status:'done'},{kind:'approval',id:'a',runId:'r',status:'pending'}]});assert.equal(badge.value.approvals,1)
  delta({docs:[],removed:[{kind:'approval',id:'a'},{kind:'run',id:'r'}]});assert.equal(badge.value.approvals,0);assert.equal(runOf.size,0)
}
// The Plume decision stays blocked for edits in any platform tab, including a background tab.
{
  const h = hooks(), src = read('../../packs/plume/src/editor.jsx'), blocked = []
  const helpers = src.slice(src.indexOf('const toText'),src.indexOf('const LEVEL'))
  const start=src.indexOf('export function PostsEditor(')+7,end=src.indexOf('  if (error && !data)',start)
  const fn=new Function('useState','useRef','useEffect','useMemo','tr','charCount','weighted','textIssues',helpers+src.slice(start,end)+'; return {set,save,setTab} }; return PostsEditor')(h.useState,h.useRef,h.useEffect,f=>f(),()=>x=>x,s=>String(s||'').length,()=>0,(await import('../../packs/plume/lib/platforms.js')).textIssues)
  // posts/savePost both return view(): issues is always an array and digest binds the editable version.
  const platform={id:'x',fields:{tweets:['old']},limits:[],issues:[],images:[],digest:'x-old',frozen:false}, data={platforms:[platform,{id:'wechat_mp',fields:{title:'t',digest:'',author:'',body:''},limits:[],issues:[],images:[],digest:'mp-old',frozen:false}]}
  const call=async (op,args)=>{ if(op==='posts') return data; assert.equal(args.expectedDigest,'x-old'); const next={...platform,fields:args.fields,digest:'x-saved'}; data.platforms=data.platforms.map(p=>p.id===next.id?next:p); return next }
  const draw=()=>h.render(()=>fn({run:{id:'r'},open:true,lang:'en',call,onBlocked:v=>blocked.push(v)}))
  draw();await tick();let v=draw();assert.equal(blocked.at(-1),false,'a clean platform view permits review')
  v.set('tweets','edited');v=draw();assert.equal(blocked.at(-1),true)
  v.setTab('wechat_mp');draw();assert.equal(blocked.at(-1),true)
  v.setTab('x');v=draw();const saving=v.save();draw();await saving;draw();await tick();draw();assert.equal(blocked.at(-1),false,'saving and refreshing the dirty tab restores review readiness')
}
// Same-page poll and save reloads may overlap: a late old response cannot undo the fresh one.
{
  const h = hooks(), src = read('../plugins/studio/src/data.js'), requests = []
  const body = src.slice(src.indexOf('function useLoad('), src.indexOf('export function useStudios'))
  const fn = new Function('useState', 'useCallback', 'useEffect', 'useRef', body + '; return useLoad')(h.useState, h.useCallback, h.useEffect, h.useRef)
  const load = () => { const d = deferred(); requests.push(d); return d.promise }
  const draw = () => h.render(() => fn(load, ['studio']))
  let view = draw(); requests[0].resolve('initial'); await tick(); view = draw()
  const old = view.reload(), fresh = view.reload()
  requests[2].resolve('new'); await fresh; requests[1].resolve('old'); await old
  assert.equal(draw().value, 'new')
  const failed = draw().reload(), newer = draw().reload()
  requests[4].resolve('newer'); await newer; requests[3].reject(new Error('stale failure')); await failed
  assert.equal(draw().value, 'newer'); assert.equal(draw().error, null)
}
// A polled studio record refresh adopts server data only while its inline form is clean.
{
  const h = hooks(), src = read('../plugins/studio/src/fields.jsx')
  const start = src.indexOf('export function RecordDialog(') + 'export '.length, end = src.indexOf('  const collTitle', start)
  const fn = new Function('useRef', 'useState', 'useEffect', 'useNote', 'defaultsOf', 'recordPatch', src.slice(start, end) + '; return { draft, set } }; return RecordDialog')(h.useRef, h.useState, h.useEffect, () => () => {}, () => ({}), recordPatch)
  const coll = { fields: [{ name: 'notes' }, { name: 'status' }] }
  let record = { id: 'idea', rev: 1, notes: 'original', status: 'writing' }
  const draw = () => h.render(() => fn({ decl: { collections: { ideas: coll } }, collName: 'ideas', record, inline: true }))
  draw(); record = { ...record, rev: 2, status: 'ready' }; assert.equal(draw().draft.status, 'ready')
  draw().set('notes', 'typing'); draw(); record = { ...record, rev: 3, notes: 'agent edit', status: 'posted' }
  assert.equal(draw().draft.notes, 'typing')
}
// A lost POST is queued again ahead of later edits; GETs cannot undo an in-flight edit.
{
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout, c = clock()
  globalThis.setTimeout = c.setTimeout; globalThis.clearTimeout = c.clearTimeout
  try {
    let server = emptyOpen(), failed = false; const calls = [], gate = deferred()
    const reg = openRegistry({ dispatchEvent() {}, addEventListener() {} }, async (_url, options) => {
      if (!options) return { ok: true, json: async () => server }
      const { ops } = JSON.parse(options.body); calls.push(ops)
      if (!failed) { failed = true; return { ok: false, status: 503 } }
      await gate.promise
      for (const op of ops) server = applyOpen(server, op)
      return { ok: true, json: async () => server }
    })
    await tick(); reg.add({ id: 'x', kind: 'web', title: 'X', reopen: { event: 'open' } }); await c.advance(250)
    reg.close('x'); await c.advance(1000); await reg.load()
    assert.equal(reg.list().length, 0)
    gate.resolve(); await tick(); await c.advance(250)
    assert.deepEqual(calls.at(-1).map(x => x.op), ['add', 'close']); assert.equal(server.closed[0].id, 'x')
  } finally { globalThis.setTimeout = realSet; globalThis.clearTimeout = realClear }
}
console.log('async UI check: ok')

// Two surfaces share one new dsh session, preserve prompt order, and remove refused asks from its queue.
{
  const src=read('../workbench/lib/assistant.js'), begin=src.indexOf('      const observedSession =',src.indexOf('async chatSend(')), end=src.indexOf('\n    },',begin)
  const m={briefed:false}, rows={a:{id:'a'},b:{id:'b'},bad:{id:'bad'},good:{id:'good'}}, create=deferred(), prompts=[]
  let creates=0, refuse=false
  const env={m,s:{},ingest:async()=>m.sessionId?{status:'idle'}:null,ROLL:100,expand:()=>'',join:()=>'/fake',home:'/fake',mkdirSync:()=>{},now:()=>1,selectModel:async()=>{},sc:{create:async()=>{creates++;await create.promise;return{sessionId:'one'}},rename:async()=>{},prompt:async p=>{if(refuse){refuse=false;throw Error('refused')}prompts.push(p)}},save:()=>{},agentOf:async()=>({}),equip:()=>{},brief:()=>'',workflowNames:()=>[],contextOf:()=>'',conv:{memoryBrief:()=>''},systemSkill:()=>'',liveNotes:()=>[],noteTag:()=>'',toldNotes:()=>{},langTag:()=>'',nowTag:()=>'',pickTag:()=>'',lang:'en',asks:()=>rows,randomUUID:()=>String(Math.random()),answered:(a,error)=>Object.assign(a,{state:'failed',error})}
  const api=new Function('env',`with(env){let dshSending=Promise.resolve(),dshPending=0;return {send(a,q,idle=false){${src.slice(begin,end)}},pending:()=>dshPending}}`)(env)
  const a=api.send(rows.a,'first'),b=api.send(rows.b,'second');await tick();assert.equal(creates,1);create.resolve();await Promise.all([a,b]);assert.equal(creates,1);assert.deepEqual(prompts.map(p=>p.content[0].text),['first','second']);assert.deepEqual(m.dshAsks,['a','b']);assert.equal(api.pending(),0)
  refuse=true;await assert.rejects(api.send(rows.bad,'bad'),/refused/);assert.equal(rows.bad.state,'failed');assert.ok(!m.dshAsks.includes('bad'))
  await api.send(rows.good,'good');assert.deepEqual(m.dshAsks,['a','b','good'])
  env.ingest=async()=>{delete m.sessionId;return null};rows.expired={id:'expired'};await api.send(rows.expired,'after the old session disappeared');assert.equal(creates,2,'a missing old session is replaced on the same send');assert.equal(prompts.at(-1).sessionId,'one')
}
// Start/stop/start while microphone permission is pending owns exactly one current recorder.
for(const reverse of [false,true]) {
  const src=read('./src/desktop/voice.js'), begin=src.indexOf('export function createVoiceInput(')+7,end=src.indexOf('  const toggle =',begin), opened=[]
  const fn=new Function('record','editable','document','navigator','requestAnimationFrame','cancelAnimationFrame','clearTimeout','setTimeout',src.slice(begin,end)+';return {start,stop,state:()=>s}};return createVoiceInput')(()=>{const d=deferred();opened.push(d);return d.promise},()=>false,{activeElement:null},{mediaDevices:{getUserMedia(){}}},()=>1,()=>{},()=>{},()=>1)
  const v=fn({lang:()=> 'en'}),a=v.start();await v.stop();const b=v.start();let old=0,current=0
  const first={cancel(){old++},level:()=>0,seconds:()=>0},second={cancel(){current++},level:()=>0,seconds:()=>0}
  if(reverse){opened[1].resolve(second);await b;opened[0].resolve(first);await a}else{opened[0].resolve(first);await a;opened[1].resolve(second);await b}
  assert.equal(old,1);assert.equal(current,0);assert.equal(v.state().phase,'listening');await v.stop();assert.equal(current,1)
}
// Slow session reads cannot overlap and append the same sequence twice.
{
 const src=read('../plugins/agent-hub/src/sessions.jsx'),begin=src.indexOf('function SessionView('),end=src.indexOf('  useEffect(() => { end.current',begin),h=hooks(),calls=[];let poll
 const fn=new Function('useState','useRef','useEffect','useT','call','setInterval','clearInterval',src.slice(begin,end)+';return{events}};return SessionView')(h.useState,h.useRef,h.useEffect,()=>x=>x,()=>{const d=deferred();calls.push(d);return d.promise},f=>(poll=f,1),()=>{})
 const draw=()=>h.render(()=>fn({d:{id:'s',seq:0,state:'working'}}));draw();poll();poll();assert.equal(calls.length,1);calls[0].resolve({events:[{seq:1,text:'one'}]});await tick();assert.equal(draw().events.length,1);poll();assert.equal(calls.length,2);calls[1].resolve({events:[]});await tick()
}
// A translation requested for one evidence item cannot appear under the next item.
{
 const src=read('../workbench/src/ledger.jsx'),begin=src.indexOf('export function EvidenceDrawer(')+7,end=src.indexOf("  useEffect(() => {\n    const k =",begin),h=hooks(),tr=deferred();let seq=1
 const fn=new Function('useState','useRef','useEffect','useMemo','useT','citations','fileOf','call','targetFor','errorText',src.slice(begin,end)+';return{shown,trBusy,translate}};return EvidenceDrawer')(h.useState,h.useRef,h.useEffect,f=>f(),()=>x=>x,()=>new Map(),()=>null,async(op,args)=>op==='translate'?tr.promise:{content:'evidence '+args.seq},()=> 'en',(_t,e)=>e.message)
 const draw=()=>h.render(()=>fn({run:{id:'r'},evidence:[{seq:1},{seq:2}],seq}));draw();await tick();const translating=draw().translate();seq=2;draw();await tick();tr.resolve({texts:['old translation']});await translating;assert.equal(draw().shown,null);assert.equal(draw().trBusy,false)
}
// A sign-in dialog which closes before start returns cleans up only its own attempt; late input frames stay with it.
{
 const src=read('../connectors/src/main.jsx'),start=src.indexOf('function SigninDialog('),end=src.indexOf('  const at = e =>',start),h=hooks(),calls=[],c=clock();let id='a',n=0
 const fn=new Function('useState','useRef','useEffect','call','crypto','errText','setTimeout','clearTimeout',src.slice(start,end)+';return{frame,send}};return SigninDialog')(h.useState,h.useRef,h.useEffect,(op,args)=>{const d=deferred();calls.push({...d,op,args});return d.promise},{getRandomValues:a=>(a.fill(++n),a)},(_t,e)=>e.message,c.setTimeout,c.clearTimeout)
 const draw=()=>h.render(()=>fn({t:x=>x,id,onClose:()=>{},onDone:()=>{}}))
 draw();calls[0].resolve({status:'running'});await tick();calls[1].resolve({status:'running',seq:0,frame:'first'});await tick();draw().send({type:'text',text:'old'})
 id='b';draw();const nextStart=calls.find(x=>x.op==='signinStart'&&x.args.id==='b');nextStart.resolve({status:'running'});await tick();draw().send({type:'text',text:'new'})
 const oldInput=calls.find(x=>x.op==='signinInput');oldInput.resolve({seq:100,frame:'late-old'});await tick();assert.notEqual(draw().frame,'late-old')
 const newInput=calls.filter(x=>x.op==='signinInput').at(-1);assert.equal(newInput.args.id,'b');assert.equal(newInput.args.text,'new');newInput.resolve({seq:1,frame:'current'});await tick();assert.equal(draw().frame,'current')
}

// Disposing, losing focus or cancelling a shortcut fences pending microphone and transcription callbacks.
for (const phase of ['permission','transcription','blur','shortcut']) {
  const src=read('./src/desktop/voice.js'),mic=deferred(),text=deferred(),c=clock(),listeners={};let cancelled=0,frames=0,delivered=0
  const env={record:()=>mic.promise,editable:()=>false,document:{activeElement:null},navigator:{mediaDevices:{getUserMedia(){}},platform:'Mac'},window:{dispatchEvent(){},addEventListener(k,f){listeners[k]=f},removeEventListener(k,f){if(listeners[k]===f)delete listeners[k]}},HOTKEY_DEFAULT:{code:'AltRight',mods:[],mode:'hold'},hotkeyLabel:()=>'',isHotkey:e=>e.code==='AltRight',HOLD:220,fetch:async url=>url.endsWith('/config')?{ok:false}:{ok:true,json:()=>text.promise},requestAnimationFrame:()=>++frames,cancelAnimationFrame(){},clearTimeout:c.clearTimeout,setTimeout:c.setTimeout,Event}
  const make=new Function('env',`with(env){${src.slice(src.indexOf('export function createVoiceInput(')+7)};return createVoiceInput}`)(env)
  const v=make({lang:()=> 'en',toPalette:()=>delivered++})
  if(phase==='blur'||phase==='shortcut'){
    listeners.keydown({code:'AltRight',repeat:false});await c.advance(220);assert.equal(v.get().phase,'listening')
    if(phase==='blur')listeners.blur();else listeners.keydown({code:'KeyK',repeat:false})
    mic.resolve({cancel(){cancelled++},level:()=>0});await tick();assert.equal(cancelled,1);assert.equal(frames,0);v.dispose()
  }else{
    const started=v.start()
    if(phase==='permission'){
      v.dispose();mic.resolve({cancel(){cancelled++},level:()=>0});await started;assert.equal(cancelled,1);assert.equal(frames,0)
    }else{
      mic.resolve({cancel(){cancelled++},level:()=>0,seconds:()=>1,stop:()=>new Uint8Array()});await started;const stopped=v.stop();await tick();v.dispose();text.resolve({text:'late words'});await stopped;assert.equal(delivered,0)
    }
  }
  assert.equal(v.get().phase,'idle')
}

// A workflow card reloads an already-known workflow; a new revision remounts the editor after the dirty guard.
{
 const src=read('../workbench/src/workflows.jsx'),a=src.indexOf('export function WorkflowsPage(')+7,b=src.indexOf('  if (!data) return',a),h=hooks(),requests=[],listeners={};let discard=true
 const win={addEventListener(k,f){listeners[k]=f},removeEventListener(k,f){if(listeners[k]===f)delete listeners[k]},confirm:()=>discard}
 const fn=new Function('useState','useRef','useEffect','useMemo','useT','NS','localizeWorkflows','local','call','cacheWorkflows','errorText','window',src.slice(a,b)+';return {view,open,dirty,raw}};return WorkflowsPage')(h.useState,h.useRef,h.useEffect,f=>f(),()=>x=>x,'wb',(_t,x)=>x,{get:()=>null,set(){}},()=>{const d=deferred();requests.push(d);return d.promise},()=>{},(_t,e)=>e.message,win)
 const data=revision=>({mine:[{id:'w',title:revision,revision}],builtIn:[]}),draw=()=>h.render(()=>fn({toast(){},openPanel(){}}))
 draw();requests[0].resolve(data('v1'));await tick();draw().open('mine','w');const old=draw().view
 const opening=listeners['wb:needs']({detail:{workflow:'w',panel:null}});assert.equal(requests.length,2,'opening the saved-workflow card always reads current server data')
 requests[1].resolve(data('v2'));await opening;const current=draw().view;assert.equal(current.revision,'v2')
 const key=new Function('view','return '+src.match(/<ReactFlowProvider key=\{(`[^`]+`)\}/)[1]);assert.notEqual(key(old),key(current),'the mounted editor must use the refreshed definition')
 draw().dirty.current=true;discard=false;const refused=listeners['wb:needs']({detail:{workflow:'w',panel:null}});requests[2].resolve(data('v3'));await refused;assert.equal(draw().view.revision,'v2','refusing to discard keeps the existing editor mounted')
 discard=true;draw().dirty.current=false;const earlier=listeners['wb:needs']({detail:{workflow:'w',panel:null}}),later=listeners['wb:needs']({detail:{workflow:'w',panel:null}})
 requests[4].resolve(data('v5'));await later;requests[3].resolve(data('v4'));await earlier;assert.equal(draw().view.revision,'v5');assert.equal(draw().raw.mine[0].revision,'v5','an old list response cannot replace the newest one')
 const stale=listeners['wb:needs']({detail:{workflow:'w',panel:null}});draw().open('mine','w');requests[5].resolve(data('v6'));await stale;assert.equal(draw().view.revision,'v5','delayed opening cannot overtake a later navigation')
}
// Existing workflow saves use the loaded revision; accepted saves advance the baseline even before the list reloads.
{
 const src=read('../workbench/src/wf-editor.jsx'),a=src.indexOf('  const save = async enable => {'),b=src.indexOf('  const setStatus =',a),calls=[],revision={current:'v1'}
 const env={busy:'',idTaken:false,saving:{current:false},setBusy(){},builtIn:false,revision,now:'{"id":"w"}',fresh:false,call:async(op,args)=>(calls.push({op,args}),{workflow:{id:'w',status:'draft',revision:'v2'},errors:[]}),setErrors(){},setSaved(){},onDirty(){},toast(){},t:x=>x,errorText:(_t,e)=>e.message,onSaved:async()=>{}}
 const save=new Function('env',`with(env){${src.slice(a,b)};return save}`)(env);await save(false);await save(false);assert.deepEqual(calls.map(c=>c.args.expect),['v1','v2'])
}
// More than one server batch of open-list edits drains without a permanent 400/retry loop.
{
 const c=clock(),beforeSet=globalThis.setTimeout,beforeClear=globalThis.clearTimeout;globalThis.setTimeout=c.setTimeout;globalThis.clearTimeout=c.clearTimeout
 try{
  let server=emptyOpen();const batches=[]
  const reg=openRegistry({dispatchEvent(){},addEventListener(){}},async(_url,options)=>{
   if(!options)return{ok:true,json:async()=>server};const{ops}=JSON.parse(options.body);batches.push(ops.length);if(ops.length>100)return{ok:false,status:400};for(const op of ops)server=applyOpen(server,op);return{ok:true,json:async()=>server}
  })
  await tick();reg.add({id:'many',kind:'web',title:'Many',reopen:{event:'open'}});for(let i=0;i<250;i++)reg.use('many');await c.advance(2000)
  assert.deepEqual(batches,[100,100,51]);assert.equal(server.items[0].id,'many')
 }finally{globalThis.setTimeout=beforeSet;globalThis.clearTimeout=beforeClear}
}
// A removed agent's tombstone stays in the synced cache but must disappear from the desk widget.
{
 const src=read('../plugins/agent-hub/src/desk.jsx'),a=src.indexOf('function linesOf('),b=src.indexOf('const SAMPLE =',a)
 const linesOf=new Function(src.slice(a,b)+';return linesOf')(),s={agents:new Map([['live',{id:'live'}],['deleted',{id:'deleted',deleted:true}]]),sessions:new Map(),jobs:new Map()}
 assert.deepEqual(linesOf(s,[]).map(x=>x.agent.id),['live'])
}

// A failed credential write keeps the provider form and key for a retry, without reporting success.
{
  const h = hooks(), src = read('./src/settings.jsx'), start = src.indexOf('function AddProvider('), end = src.indexOf('  if (!open) return ', start)
  const body = src.slice(start, end) + ';return {open,f,setF,found,setFound,setChosen,busy,add} }; return AddProvider'
  const errors = [], notes = [], done = []
  let failKey = true
  const fn = new Function('useState','ID','keyEnv','modelEntry','api','errText',body)(h.useState,/^[a-z]+$/,id=>id+'_KEY',m=>m,async()=>{if(failKey)throw new Error('key storage failed')},(_t,e)=>e.message)
  const draw = () => h.render(() => fn({ t:{saved:'saved'}, providers:{}, edit:async()=>true, note:x=>notes.push(x), setError:e=>errors.push(e), preset:{id:'local',key:'kept-secret',baseURL:'http://local'}, onDone:id=>done.push(id) }))
  let v=draw();v.setFound([{id:'whisper'}]);v.setChosen(new Set(['whisper']));v=draw()
  await v.add();v=draw()
  assert.equal(v.open,true);assert.equal(v.f.key,'kept-secret');assert.equal(v.busy,false)
  assert.deepEqual(errors,['key storage failed']);assert.deepEqual(notes,[]);assert.deepEqual(done,[])
  failKey=false;await v.add();v=draw();assert.equal(v.open,false);assert.deepEqual(notes,['saved']);assert.deepEqual(done,['local'])
}

// Typed answers keep the question version they were written for across a background card refresh.
{
  const h = hooks(), src = read('../workbench/src/approvals.jsx')
  const begin = src.indexOf("  const [answer, keepAnswer]"), end = src.indexOf('  const sendsBack', begin)
  assert.ok(begin > 0 && end > begin)
  const fn = new Function('useState','useRef','a','help','decision','editor','editorPayload','ext','extPayload','edited', src.slice(begin,end) + ';return {setAnswer,payload}')
  let card = { payload: { rev: 0, kind: 'agent' } }
  const draw = () => h.render(() => fn(h.useState,h.useRef,card,true,false,null,undefined,null,undefined,{}))
  let v = draw();v.setAnswer('reply to old question');v=draw();assert.equal(v.payload('retry').rev,0)
  card = { payload: { rev: 1, kind: 'agent' } };v=draw();assert.equal(v.payload('retry').rev,0,'a refresh does not relabel an old answer')
  v.setAnswer('');v=draw();v.setAnswer('reply to new question');v=draw();assert.equal(v.payload('retry').rev,1)
}

// Superseded device-code attempts keep a visible expired/retry state instead of a blank dialog.
for (const phase of ['start', 'poll', 'none']) {
  const h=hooks(), c=clock(), src=read('../connectors/src/main.jsx')
  const begin=src.indexOf('function DeviceDialog('), end=src.indexOf('\n  return (',begin)+1
  const body=src.slice(begin,end)+';return {state,code} };return DeviceDialog'
  const fn=new Function('useState','useEffect','call','setTimeout','clearTimeout','setInterval','clearInterval','errText',body)(h.useState,h.useEffect,async op=>op==='deviceStart'?(phase==='start'?{state:'stale'}:{userCode:'new',expiresIn:300,interval:5}):{state:phase==='none'?'none':'stale'},c.setTimeout,c.clearTimeout,()=>1,()=>{},(_t,e)=>e.message)
  const draw=()=>h.render(()=>fn({id:'bd',t:{},onDone:()=>assert.fail('stale is not signed in')}))
  draw();await tick();draw()
  if(phase!=='start')await c.advance(5000)
  await tick();assert.equal(draw().state,'expired')
}

// The actual agent form binds the displayed document revision, instead of overwriting later agent-tool edits.
{
  const h = hooks(), src = read('../plugins/agent-hub/src/views.jsx'), start = src.indexOf('function AgentForm('), end = src.indexOf('  return (', start)
  let sent
  const make = new Function('useState','useT','NAME','call',src.slice(start,end)+'; return {save,set} }; return AgentForm')(h.useState,()=>x=>x,/^[a-z][a-z0-9-]+$/,async (_op,args)=>{sent=args;return {agent:args}})
  const agent={id:'writer',createdAt:1,revision:7,runtime:'claude',skills:[],notes:'old'}, draw=()=>h.render(()=>make({agent,env:{clis:{},endpoints:[]},onSaved:()=>{}}))
  draw().set({notes:'typed'}); await draw().save()
  assert.equal(sent.expect,7);assert.equal(sent.prev,'writer');assert.equal(sent.notes,'typed')
}

{
  const src=read('../plugins/apps/src/made.jsx'),start=src.indexOf('  const refresh ='),end=src.indexOf('  const open =',start),calls=[]
  let state={apps:[],ready:false},widgets=0
  const make=new Function('call','set','widgets','initial',`let state=initial,asking=null,refreshAgain=false,stopped=false;${src.slice(start,end)};return {refresh,stop(){stopped=true}}`)
  const x=make(()=>{const d=deferred();calls.push(d);return d.promise},v=>{state=v},()=>widgets++,state)
  const pending=x.refresh();x.refresh();calls[0].resolve({apps:[{id:'old'}]});await tick();assert.equal(calls.length,2)
  calls[1].resolve({apps:[{id:'new'}]});await pending;assert.deepEqual(state.apps,[{id:'new'}]);assert.equal(widgets,2)
  const late=x.refresh();x.stop();calls[2].resolve({apps:[{id:'disposed'}]});await late;assert.deepEqual(state.apps,[{id:'new'}])
}

// A rejected revision keeps its form and the words the person typed; a successful one closes it.
{
  const h=hooks(),src=read('./src/tasks/tasks.jsx'),start=src.indexOf('function TaskDetail('),end=src.indexOf('  const ended =',start)
  const prefix=src.slice(start,end).replace(/  if \(!task\) return <p[^\n]+\n/,'')
  const W={failed:'Failed: ',revised:'Sent'},task={id:'t',state:'to-confirm',resultVersion:1};let fail=true
  const act={revise:async()=>{if(fail)throw new Error('changedMeanwhile')}}
  const Detail=new Function('useState','useEffect','useTask',prefix+';return {run,revise,setRevise,note} };return TaskDetail')(h.useState,h.useEffect,()=>({task,reload:async()=>{}}))
  const draw=()=>h.render(()=>Detail({id:'t',W,lang:'en'}))
  const line=src.split('\n').find(l=>l.includes('<form className="tk-revise"'))
  const submit=line.slice(line.indexOf('onSubmit={')+10,line.lastIndexOf('}'))
  const handler=v=>new Function('run','act','task','revise','W','setRevise','return ('+submit+')')(v.run,act,task,v.revise,W,v.setRevise)
  draw().setRevise('fix the title');handler(draw())({preventDefault(){}});await tick()
  assert.equal(draw().revise,'fix the title');assert.ok(draw().note.includes('changedMeanwhile'))
  fail=false;handler(draw())({preventDefault(){}});await tick();assert.equal(draw().revise,null)
}
// A chat draft is cleared only after acknowledgement; a failure or newer typing leaves it intact.
{
  const src=read('../workbench/src/chat.jsx'),start=src.indexOf('  const send = async (text, re = null)'),end=src.indexOf('  const replace =',start),sendBody=src.slice(start,end)
  const composerLine=src.split('\n').find(l=>l.includes('const send = text =>'))
  for(const mode of ['failure','success','newer-text','detached-failure']){
    const gate=deferred(),sending={current:false};let draft='hello there',error=null,awaiting=null,asked=0
    const send=new Function('cur','latest','setAwaiting','live','setError',sendBody+';return send')({current:{detached:mode==='detached-failure',items:[]}},async()=>{throw new Error('history unavailable')},x=>{awaiting=x},{ask:()=>{asked++;return gate.promise}},e=>{error=e})
    const compose=new Function('busy','chat','setDraft','stick','sending',composerLine+';return send')(false,{send,running:false},fn=>{draft=fn(draft)},{current:false},sending)
    const pending=compose(draft);compose(draft);assert.equal(asked,mode==='detached-failure'?0:1,'a second Enter cannot duplicate a pending send');assert.equal(draft,'hello there','keep words until acknowledgement')
    if(mode==='newer-text')draft='a different draft'
    if(mode==='failure')gate.reject(new Error('offline'));else gate.resolve(true)
    await pending;assert.equal(sending.current,false)
    assert.equal(draft,mode==='success'?'':mode==='newer-text'?'a different draft':'hello there',mode)
    if(mode.includes('failure')){assert.ok(error);assert.equal(awaiting,null)}
  }
}

// Workflow validation and readiness belong to the current draft and latest readiness operation.
{
 const src=read('../workbench/src/wf-editor.jsx'),a=src.indexOf('  useEffect(() => {\n    if (builtIn) return'),b=src.indexOf('  // a command-line tool',a)
 for(const kind of ['validation','readiness','ensure','ensure-current']){
  const h=hooks(),c=clock(),calls=[]
  const body='function probe(now){ const builtIn=false,wf={id:"draft"}; const [errors,setErrors]=useState([]); '+src.slice(a,b)+'; return {errors,ready,ensure} }; return probe'
  const probe=new Function('useState','useRef','useEffect','useMemo','call','setTimeout','clearTimeout','setBusy','toast','t','errorText',body)(h.useState,h.useRef,h.useEffect,f=>f(),(op,args)=>{const d=deferred();calls.push({...d,op,args});return d.promise},c.setTimeout,c.clearTimeout,()=>{},()=>{},x=>x,(_t,e)=>e.message)
  let now='{"id":"old"}';const draw=()=>h.render(()=>probe(now))
  draw();await c.advance(400)
  let installing
  if(kind.startsWith('ensure')) installing=draw().ensure()
  if(kind==='ensure-current'){calls.find(x=>x.op==='workflowEnsure').resolve({readiness:{draft:'current',missing:0},fetched:[],failed:[]});await installing;calls.find(x=>x.op==='workflowReadiness').resolve({draft:'old',missing:1});await tick();assert.equal(draw().ready.draft,'current','an older readiness reply cannot replace a completed install');continue}
  now='{"id":"current"}';draw();await c.advance(400)
  const newest=op=>calls.findLast(x=>x.op===op&&x.args.definition?.id==='current')
  newest('workflowValidate').resolve({errors:[]});newest('workflowReadiness').resolve({draft:'current',missing:0});await tick();draw()
  if(kind==='validation')calls.find(x=>x.op==='workflowValidate').resolve({errors:[{message:'old invalid draft'}]})
  if(kind==='readiness')calls.find(x=>x.op==='workflowReadiness').resolve({draft:'old',missing:1})
  if(kind==='ensure'){calls.find(x=>x.op==='workflowEnsure').resolve({readiness:{draft:'old',missing:1},fetched:[],failed:[]});await installing}
  await tick();const view=draw()
  assert.deepEqual(view.errors,[],`${kind}: an older draft cannot replace current validation`)
  assert.equal(view.ready.draft,'current',`${kind}: an older draft cannot replace current readiness`)
 }
}

// Every template fork creates an id the real workflow validator accepts, including dotted pack ids.
{
 const src=read('../workbench/src/workflows.jsx'),a=src.indexOf('  const fork ='),b=src.indexOf('  /** A copy',a),{validate}=await import('../workbench/lib/workflows.js'),model=await import('../workbench/src/wf-model.js')
 for(const base of ['plume.post','a'.repeat(40)]){
  const template={id:base,library:[]},data={mine:[],builtIn:[template],picks:{steps:{}}};let opened
  const fork=new Function('data','t','go','forkId',src.slice(a,b)+';return fork')(data,()=>'',v=>(opened=v),model.forkId)
  fork(template);assert.deepEqual(validate(opened.def,{bases:{}}).errors.filter(e=>e.field==='id'),[],'a default template id must be saveable')
  const first=opened.id;data.mine.push({id:first});fork(template);assert.notEqual(opened.id,first);assert.ok(opened.id.length<=40)
  data.builtIn.push({id:opened.id});data.mine.push({id:first});const second=opened.id;fork(template);assert.notEqual(opened.id,second)
 }
}

// Saving owns the draft through acknowledgement, including keyboard edits and first-save remounts.
{
 const src=read('../workbench/src/wf-editor.jsx'),a=src.indexOf('  const [items, setItemsRaw]'),b=src.indexOf('  useEffect(() => { if (shown.insert)',a),sa=src.indexOf('  const save = async enable => {'),sb=src.indexOf('  const setStatus =',sa)
 for(const fresh of [false,true]) for(const failed of [false,true]){
  const h=hooks(),gate=deferred();let parentDirty=false,calls=0
  const body='function probe(){const saving=useRef(false),start={id:"w",title:"before"},shown={},initial=()=>[{id:"initial"}];'+src.slice(a,b)+'; const now=JSON.stringify(head),builtIn=false,idTaken=false,revision={current:"v1"};const [saved,setSaved]=useState("");const dirty=now!==saved; useEffect(()=>{onDirty(dirty)},[dirty]);'+src.slice(sa,sb)+';return{head,setHead,dirty,save,setItems,items,undo,redo}};return probe'
  const probe=new Function('useState','useRef','useEffect','fresh','call','onDirty','onSaved','toast','t','errorText',body)(h.useState,h.useRef,h.useEffect,fresh,()=>{calls++;return gate.promise},v=>{parentDirty=v},async()=>{},()=>{},x=>x,(_t,e)=>e.message)
  const draw=()=>h.render(probe);let v=draw();v.setItems([{id:'before'}]);v=draw();const pending=v.save(false);await v.save(false);assert.equal(calls,1,'a second save cannot claim the same draft before rendering busy')
  v.setHead({...v.head,title:'typed during save'});v.setItems([{id:'late'}]);v.undo();v=draw();assert.deepEqual(v.items,[{id:'before'}],'undo pauses while saving');v.redo();v=draw()
  if(failed)gate.reject(new Error('offline'));else gate.resolve({workflow:{id:'w',status:'draft',revision:'v2'},errors:[]})
  await pending;v=draw()
  assert.ok(!v.dirty||parentDirty,'newer unsaved edits must retain the discard warning')
  assert.equal(v.head.title,'before','editing pauses while the save owns its draft');assert.deepEqual(v.items,[{id:'before'}])
  assert.equal(calls,1);v.setHead({...v.head,title:'after save'});v=draw();assert.equal(v.head.title,'after save');assert.equal(parentDirty,true,'success and failure both release editing')
 }
}

// Automatic recovery waits for an owned file edit without spending its resume allowance.
{
 const src=read('../workbench/lib/engine.js'),a=src.indexOf('  const autoResume ='),b=src.indexOf('  autoTimer = setTimeout(autoResume, resumeDelayMs)',a),c=clock(),row={id:'recover',dir:'/owned-folder',status:'interrupted',interruptedBy:'restart',interruptedAt:Date.now(),createdAt:1,autoResumes:0},editing=new Set([row.dir]),resumed=[]
 const env={autoTimer:null,settings:()=>({autoResume:{enabled:true,maxAgeHours:1,maxPerRun:3}}),hub:()=>({}),store:{list:()=>[row]},editing,folderKey:r=>r.dir,update:(_id,patch)=>Object.assign(row,patch),record(){},engine:{resumeRun:id=>resumed.push(id)},logger:{warn:message=>assert.fail(message)},setTimeout:c.setTimeout}
 const recover=new Function('env','with(env){'+src.slice(a,b)+';return autoResume}')(env)
 recover();assert.equal(row.autoResumes,0);assert.deepEqual(resumed,[])
 editing.clear();await c.advance(500);assert.deepEqual(resumed,['recover']);assert.equal(row.autoResumes,1)
}

// A first-save acknowledgement cannot force navigation after the person switched to another draft.
{
 const src=read('../workbench/src/workflows.jsx'),line=src.split('\n').find(l=>l.includes('onSaved={async id =>')),body=line.slice(line.indexOf('{')+1,line.lastIndexOf('}')),gate=deferred(),navigation={current:0},moves=[]
 const saved=new Function('load','view','go','navigation','shownAt','return ('+body+')')(()=>gate.promise,{kind:'fresh'},v=>moves.push(v),navigation,0)
 const pending=saved('old');navigation.current++;gate.resolve({mine:[{id:'old',revision:'v2'}]});await pending;assert.deepEqual(moves,[],'a stale save must not discard a different current draft')
}

// The missing-need Add path starts with its type selected, so it must initialize defaults without pick().
{
 const src=read('../connectors/src/main.jsx'),a=src.indexOf('function Editor('),b=src.indexOf('  const shows =',a),h=hooks(),sent=[]
 const editor=new Function('useState','call','errText',src.slice(a,b)+';return{form,save}};return Editor')(h.useState,async(_op,args)=>{sent.push(args.connection);return{id:args.connection.id}},(_t,e)=>e.message)
 const types=[{id:'x',baseUrl:{default:'https://api.x.com/2'},fields:[{name:'callback',default:'http://localhost/callback'}]}]
 const draw=()=>h.render(()=>editor({t:x=>x,types,start:{type:'x',id:'xneed'},onSaved(){}}))
 assert.equal(draw().form.baseUrl,types[0].baseUrl.default);assert.equal(draw().form.fields.callback,'http://localhost/callback');await draw().save();assert.equal(sent[0].baseUrl,types[0].baseUrl.default)
}
