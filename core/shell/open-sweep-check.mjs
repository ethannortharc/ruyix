// Things on the desk for work that is over (open-sweep.js): put away when the work is gone or archived, or over and the
// thing left unused; never what is at work, what the person grouped or pinned, nor when the work cannot be told.
import assert from 'node:assert/strict'
import { IDLE_MS, sweepOpen, workOf } from './open-sweep.js'

const now = Date.UTC(2026, 9, 18, 12)
const item = (id, extra = {}) => ({ id, kind: 'file', title: id, usedAt: now - 60e3, ...extra })
const state = { pins: ['run:rP'], items: [
  item('run:rA'), item('file:rA:1', { of: 'run:rA' }), // archived (its task)
  item('run:rGone'), // deleted
  item('file:rOld:1', { of: 'run:rOld', usedAt: now - IDLE_MS - 1 }), item('file:rOld:2', { of: 'run:rOld' }), // over: the old one only
  item('file:rLive:1', { of: 'run:rLive', usedAt: now - IDLE_MS - 1 }), // at work
  item('file:rMine:1', { of: 'run:rA', group: 'g:公众号' }), // the person's group
  item('file:rP:1', { of: 'run:rP' }), // pinned
  item('session:sX'), item('page:inbox'), item('win:term:terminal', { bg: true }),
] }
const runs = { rA: { status: 'done', taskId: 'tA' }, rOld: { status: 'done' }, rLive: { status: 'running', taskId: 'tA' }, rP: { status: 'done', archivedAt: 1 } }
const wb = { run: id => runs[id] || null, tasks: { get: id => (id === 'tA' ? { id, state: 'done', archived: true } : null) } }
runs.rLive.taskId = null
const work = workOf({ workbench: () => wb, hub: () => ({ sessions: () => [] }) })
assert.deepEqual(sweepOpen(state, work, now), ['run:rA', 'file:rA:1', 'run:rGone', 'file:rOld:1', 'session:sX'])
// nothing known about the work (the workbench not loaded yet): nothing closed
assert.deepEqual(sweepOpen(state, workOf({}), now), [])
console.log('open sweep check: ok')
