// The viewer's files by their own links (src/url-files.js; a studio's materials): names that say their kind and are each
// one's own, read through the link; only this page's links are opened in the viewer's window.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const { sameOrigin, urlFiles } = await import('./src/url-files.js')

const here = 'http://127.0.0.1:3280/desk'
assert.equal(sameOrigin('/api/ruyix-studio/material?id=1', here), true)
assert.equal(sameOrigin('api/ruyix-studio/material?id=1', here), true)
assert.equal(sameOrigin('http://127.0.0.1:3280/x', here), true)
assert.equal(sameOrigin('//evil.example/x.png', here), false, 'a protocol-relative link is another site')
assert.equal(sameOrigin('https://evil.example/x.png', here), false)
assert.equal(sameOrigin('javascript:alert(1)', here), false)

const got = []
const { names, source } = urlFiles([
  { url: '/m/1', name: 'cover', kind: 'image' }, { url: '/m/2', name: 'notes.md' }, { url: '/m/3', name: 'notes.md' }, { url: '/m/4', name: 'a/b', kind: 'pdf' },
], async u => { got.push(u); return { ok: true, text: async () => `text of ${u}` } })
assert.deepEqual(names, ['cover.png', 'notes.md', '3-notes.md', 'a-b.pdf'], 'its kind in its name, one of its own, no folders')
assert.equal(source.url('3-notes.md'), '/m/3')
assert.deepEqual(await source.fileAt('notes.md'), { text: 'text of /m/2', size: 12 })
assert.deepEqual(got, ['/m/2'])
await assert.rejects(source.pageOf('x.html'), /only from a run or a session/)
// SVG links are fetched as inert image data, including the plain-text home/material routes.
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><text>SVG &amp; %</text></svg>'
  const { source } = urlFiles([{ url: '/api/hfile?path=icon.svg', name: 'icon.SVG' }], async () => new Response(svg, { headers: { 'content-type': 'text/plain' } }))
  const image = await source.fileAt('icon.SVG')
  assert.ok(image.image.startsWith('data:image/svg+xml;charset=utf-8,'))
  assert.equal(decodeURIComponent(image.image.split(',').slice(1).join(',')), svg)
  assert.equal(image.size, svg.length)
}

// Execute the review's actual decision handler: discard decisions remain available for an invalid editor, but
// never silently discard a draft (including one typed while comment autosave was still in flight).
{
  const src = readFileSync(new URL('./src/review.jsx', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('  const decide = async (i, extra) => {'), src.indexOf('  const stepName ='))
  for (const action of ['stop', 'revise']) {
    let flush, consent = false
    const dirty = { current: false }, blocked = { current: false }, saving = { current: false }, decisions = [], confirmations = []
    const saved = { flush: () => new Promise(r => { flush = r }) }
    const bindings = { a: { payload: { options: [{ action }] } }, dirty, blocked, saving, saved,
      window: { confirm: text => { confirmations.push(text); return consent } }, t: x => x,
      onDecide: (...args) => { decisions.push(args) } }
    const decide = new Function(...Object.keys(bindings), `${body}\nreturn decide`)(...Object.values(bindings))
    const pending = decide(0, { from: 'plan' })
    dirty.current = true; blocked.current = true; flush(); await pending
    assert.deepEqual(confirmations, ['rv.discardEditor'], `${action} checks the latest draft after comments flush`)
    assert.equal(decisions.length, 0, 'declining keeps the editor and draft open')
    consent = true
    const approved = decide(0, { from: 'plan' }); flush(); await approved
    assert.deepEqual(decisions, [[0, { from: 'plan' }]], 'confirmed discard preserves the selected destination')
    dirty.current = false
    const invalid = decide(0); flush(); await invalid
    assert.equal(decisions.length, 2, 'an error-only editor still allows stop or revise without a draft warning')
    assert.equal(confirmations.length, 2)
    const working = decide(0); saving.current = true; flush(); await working
    assert.equal(decisions.length, 2, 'a file save starting during flush still prevents the decision')
    saving.current = false
    saved.flush = async () => { throw new Error('comments could not be saved') }
    await decide(0)
    assert.equal(decisions.length, 2, 'comment autosave errors keep the existing visible failure and do not proceed')
  }
  const bindings = { a: { payload: { options: [{ action: 'accept' }] } }, saving: { current: false }, blocked: { current: true }, dirty: { current: true }, saved: { flush: () => assert.fail('blocked accept must not flush') }, window: { confirm: () => assert.fail('accept cannot discard') }, t: x => x, onDecide: () => assert.fail('blocked accept must not proceed') }
  await new Function(...Object.keys(bindings), `${body}\nreturn decide`)(...Object.values(bindings))(0)
}

{
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { pageOf, LIMITS } = await import('./lib/pages.js')
  const dir = mkdtempSync(join(tmpdir(), 'ruyix-css-cycle-')), run = { id: 'page', dir }
  try {
    writeFileSync(join(dir,'index.html'),'<link rel="stylesheet" href="a.css">')
    writeFileSync(join(dir,'a.css'),'body{background:url(a.css)}')
    let page = pageOf(run,'index.html')
    assert.ok(page.left.includes('a.css'));assert.equal(page.inlined.filter(p=>p==='a.css').length,1);assert.ok(page.html.length<10000)
    writeFileSync(join(dir,'a.css'),'body{background:url(b.css)}');writeFileSync(join(dir,'b.css'),'body{background:url(a.css)}')
    page = pageOf(run,'index.html');assert.ok(page.left.includes('a.css'));assert.ok(page.html.length<10000)
    const budget = LIMITS.total
    try {
      LIMITS.total = 200
      writeFileSync(join(dir,'a.css'),'x{background:url(b.css)}');writeFileSync(join(dir,'b.css'),' '.repeat(80))
      page=pageOf(run,'index.html');assert.ok(page.left.includes('a.css'));assert.deepEqual(page.inlined,[], 'discarded nested data is not reported as part of the page')
    } finally { LIMITS.total = budget }
    writeFileSync(join(dir,'index.html'),'<link rel="stylesheet" href="n0.css">')
    for(let i=0;i<80;i++)writeFileSync(join(dir,`n${i}.css`),`x{background:url(n${i+1}.css)}`)
    page=pageOf(run,'index.html');assert.ok(page.left.includes(`n${LIMITS.depth}.css`));assert.ok(page.html.length<LIMITS.total)
  }finally{rmSync(dir,{recursive:true,force:true})}
}
// Real URL viewer windows must be accepted and reopenable by the shell's open-things registry.
{
 const {readFileSync}=await import('node:fs'),{applyOpen,emptyOpen}=await import('../shell/open-model.js'),{hashOf}=await import('./src/open-things.js')
 const src=readFileSync(new URL('./src/viewer-window.jsx',import.meta.url),'utf8'),body=src.slice(src.indexOf('export function openViewer(')+7)
 const {namesOf}=await import('./src/win-names.js')
 const openViewer=new Function('sameOrigin','hashOf','namesOf','Images','ViewerWindow','sizeFor','VIEW',body+';return openViewer')(url=>sameOrigin(url,here),hashOf,namesOf,null,()=>{},()=>({}),'ruyix-workbench:view')
 const windows=[];let state=emptyOpen();const desk={open:w=>{state=applyOpen(state,{op:'add',item:w});windows.push(w)}}
 const files=[{url:'/api/ruyix-workbench/hfile?path='+encodeURIComponent('/notes/中文 space.md'),name:'中文.md'}]
 assert.equal(openViewer({files},{desk,t:x=>x}),true);const first=windows[0].id
 openViewer({files},{desk,t:x=>x});assert.equal(windows[1].id,first,'same files reopen the same window');assert.equal(state.items.length,1)
 const many=Array.from({length:200},(_,i)=>({url:'/api/ruyix-workbench/hfile?path='+encodeURIComponent('/notes/'+i+'-'+ 'long'.repeat(20)+'.md'),name:i+'.md'}))
 openViewer({files:many},{desk,t:x=>x});assert.equal(state.items.length,2);assert.deepEqual(state.items.find(x=>x.id===windows.at(-1).id).reopen.detail.files,many)
 assert.throws(()=>applyOpen(state,{op:'add',item:{...windows[0],kind:'page',reopen:{event:'open',detail:'x'.repeat(3000)}}}),/2000/,'ordinary open metadata keeps its existing budget')
 assert.throws(()=>applyOpen(state,{op:'add',item:{...windows[0],reopen:{event:'open',detail:'x'.repeat(300000)}}}),/reopen/,'file metadata is bounded too')
}
// A run's results window is named in both languages (the desk shows the page's, which can change while it is open); a row
// kept from before that, in the one language it was opened in, gets both — only for the workbench's own windows.
{
  const { applyOpen, emptyOpen, nameOf } = await import('../shell/open-model.js'), { hashOf } = await import('./src/open-things.js')
  const { keptNames, namesOf } = await import('./src/win-names.js')
  const src = readFileSync(new URL('./src/viewer-window.jsx', import.meta.url), 'utf8'), body = src.slice(src.indexOf('export function openViewer(') + 7)
  const openViewer = new Function('sameOrigin', 'hashOf', 'namesOf', 'Images', 'ViewerWindow', 'sizeFor', 'VIEW', `${body};return openViewer`)(url => sameOrigin(url, here), hashOf, namesOf, null, () => {}, () => ({}), 'ruyix-workbench:view')
  let state = emptyOpen()
  const desk = { open: w => { state = applyOpen(state, { op: 'add', item: { ...w, id: `win:${w.id}` } }) } }
  openViewer({ run: 'r1' }, { desk, t: () => 'Results', title: 'the latest ai news' })
  openViewer({ session: 's1' }, { desk, t: () => 'What it made' })
  const [run, session] = state.items
  assert.deepEqual([nameOf(run, 'zh'), nameOf(run, 'en')], ['the latest ai news · 结果', 'the latest ai news · Results'])
  assert.deepEqual([nameOf(session, 'zh'), nameOf(session, 'en')], ['它做出的文件', 'What it made'])
  assert.deepEqual(keptNames('win:viewer:r02fee28', 'the latest ai and robot news · Results'), { zh: 'the latest ai and robot news · 结果', en: 'the latest ai and robot news · Results' })
  assert.deepEqual(keptNames('win:viewer:session:s1', '它做出的文件'), { zh: '它做出的文件', en: 'What it made' })
  assert.deepEqual(keptNames('win:ruyix-tasks-window', 'Tasks'), { zh: '任务', en: 'Tasks' })
  assert.deepEqual(keptNames('win:answer:a1', '回答'), { zh: '回答', en: 'Answer' })
  assert.equal(keptNames('win:answer:a1', '今天是星期几？'), null, "an answer named by its question keeps it")
  assert.equal(keptNames('win:term:zellij', 'Terminal · Results'), null, "another's window is not the workbench's to name")
  state = applyOpen(state, { op: 'add', item: { id: 'win:viewer:r2', kind: 'file', title: 'news · Results', win: 'viewer:r2', reopen: { event: 'ruyix-workbench:view', detail: { run: 'r2' } } } })
  state = applyOpen(state, { op: 'rename', id: 'win:viewer:r2', names: keptNames('win:viewer:r2', 'news · Results') })
  assert.equal(nameOf(state.items.find(x => x.id === 'win:viewer:r2'), 'zh'), 'news · 结果')
}
console.log('viewer check: ok (including review discard decisions)')
