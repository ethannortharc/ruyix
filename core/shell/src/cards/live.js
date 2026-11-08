// A task card as it is now (docs/design/work-in-one-place.md: what was started in the conversation shows there how it
// goes and how it ended). The card in a message says the task as it was when the message was written; this reads the
// task itself — when it changes ('ruyix:tasks' { ids }: those, even one that was over — 再改 sends it back to work), and,
// while it is not over, when the window comes back and every so often — so every card of it shows what it is doing now,
// then how it ended and what it made, however old the message. One read per task for all its cards.
//   useLiveTask(id, lang, { state, result }) → { task, outputs } | null (nothing read yet)
import { useEffect, useState } from 'react'
import { CHANGED, op } from '../tasks/data.js'

const OVER = new Set(['done', 'failed', 'stopped'])
const SLOW_MS = 15000
const known = new Map() // id → { task, outputs }
const watchers = new Map() // id → Set of setters
const langs = new Map() // id → the language its words are asked in
const states = new Map() // id → its state as last known (read, or as its message said)
const reading = new Set()
let timer = null, waiting = null

async function read(id) {
  if (reading.has(id)) return
  reading.add(id)
  try {
    const r = await op('taskGet', { id, lang: langs.get(id) || 'zh' })
    const v = { task: r.task || null, outputs: r.outputs || [] }
    known.set(id, v)
    if (v.task?.state) states.set(id, v.task.state)
    for (const set of watchers.get(id) || []) set(v)
  } catch { /* gone, or not here: the card keeps what its message said */ }
  reading.delete(id)
}
const open = id => !OVER.has(states.get(id))
/** Read again the tasks shown and not over, and those named changed (a burst is one read). */
const named = new Set()
function again(e) {
  for (const id of e?.detail?.ids || []) named.add(String(id))
  clearTimeout(waiting)
  waiting = setTimeout(() => {
    if (document.hidden) return
    for (const id of watchers.keys()) if (open(id) || named.has(id)) read(id)
    named.clear()
  }, 300)
}
function start() {
  if (timer) return
  window.addEventListener(CHANGED, again)
  window.addEventListener('focus', again)
  timer = setInterval(again, SLOW_MS)
}
function stop() {
  if (!timer || watchers.size) return
  window.removeEventListener(CHANGED, again)
  window.removeEventListener('focus', again)
  clearInterval(timer); timer = null
}

export function useLiveTask(id, lang = 'zh', said = {}) {
  const [v, set] = useState(() => (id && known.get(id)) || null)
  useEffect(() => {
    if (!id) return
    langs.set(id, lang)
    if (!states.has(id) && said.state) states.set(id, said.state)
    if (!watchers.has(id)) watchers.set(id, new Set())
    watchers.get(id).add(set)
    start()
    // a task the message already shows as over, with how it ended, needs no read
    if (!known.has(id) && !(OVER.has(said.state) && said.result)) read(id)
    else if (known.has(id)) set(known.get(id))
    return () => { const w = watchers.get(id); w?.delete(set); if (w && !w.size) watchers.delete(id); stop() }
  }, [id, lang])
  return v
}
