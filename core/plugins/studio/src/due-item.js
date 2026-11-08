// A record whose time has come as an item of the desk's work list (src/due.js puts them there; plain, checked in node).
const WORDS = {
  zh: { title: t => `到点了：${t}`, none: '还没开写', running: '还在写', waiting: '写好了，去发布', stopped: '上次没写完，再开写', done: '已经发了' },
  en: { title: t => `Time: ${t}`, none: 'Not begun yet', running: 'Still being written', waiting: 'Ready: publish it', stopped: 'Last try stopped: write it again', done: 'Already published' },
}
const stateOf = run => (!run ? 'none' : ['waiting', 'done'].includes(run.status) ? 'waiting' : ['queued', 'running'].includes(run.status) ? 'running' : 'stopped')

/** A due record as an item of the work list. */
export function dueItem(x, lang = 'zh') {
  const W = WORDS[lang] || WORDS.en, st = stateOf(x.run), text = W[st]
  return {
    id: `studio:${x.studio}:${x.collection}:${x.id}`, kind: 'studio', title: x.title, studio: { id: x.studio, collection: x.collection, record: x.id },
    agents: [{ id: 'studio', kind: 'person', state: 'waiting', step: text }], state: 'waiting', wait: { kind: 'do', title: W.title(x.title) },
    segs: [{ title: text, st: 'wait' }], cur: 0, startedAt: x.at, endedAt: null, ok: false, seen: false,
    lines: [{ at: x.at, agent: 'studio', kind: 'wait', text: `${W.title(x.title)} · ${text}` }],
    open: { event: 'ruyix:open', detail: { panel: `ruyix-studio-${x.studio}`, studio: x.studio, collection: x.collection, record: x.id } },
  }
}

