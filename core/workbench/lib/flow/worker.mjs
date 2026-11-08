// A script step's guest in a worker thread (where dsh has no PTC process to confine it): the same realm (guest.mjs),
// its host calls carried over the thread's port — stopped by terminating the thread.
import { parentPort } from 'node:worker_threads'
import { runFlowGuest } from './guest.mjs'

let n = 0
const waiting = new Map()
const ask = (kind, payload) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); parentPort.postMessage({ id, kind, payload }) })
parentPort.on('message', m => {
  // (the host's ping: answered from this thread's event loop, so a script that spins and never yields leaves it unanswered)
  if (m.ping) return parentPort.postMessage({ pong: true })
  const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m.value) }
})
parentPort.postMessage({ done: await runFlowGuest({ begin: () => ask('begin', '{}'), call: req => ask('call', req) }) })
