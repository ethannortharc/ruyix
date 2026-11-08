#!/usr/bin/env node
// ruyix changes — this Ruyix's changes to its surfaces (../surfaces.js), for when its page is hard to use:
//   ruyix changes                the latest, newest first
//   ruyix changes undo [<id>]    undo one (without an id: the last one applied)
//   ruyix changes restore <id>   back to before it (the changes applied after it undone too)
//   ruyix changes show <id>      one change: what it does, every line of it
// It never applies a proposal (that is the person's, on Ruyix's page: an agent's shell could run this command too) — it
// only goes back to what the person applied before, and never undoes an undo (that would bring back what they took away).
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createChanges } from '../surfaces.js'

// what a change says (its summary, a board's title) is shown, never run: a terminal's control characters and the marks
// that turn text around come out as \u escapes
const shown = v => String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const say = v => console.log(shown(v)), sayErr = v => console.error(shown(v))
const changes = createChanges({ home: process.env.RUYIX_HOME || join(homedir(), '.ruyix') })
const [cmd = 'list', id] = process.argv.slice(2)
const line = v => `${v.id}  ${v.state.padEnd(9)} ${new Date(v.undoneAt || v.appliedAt || v.at).toISOString().slice(0, 16).replace('T', ' ')}  ${v.summary}`
try {
  if (cmd === 'list') { const all = await changes.list({ limit: 20 }); say(all.length ? all.map(line).join('\n') : 'no changes') }
  else if (cmd === 'undo') { const x = id || await changes.last(); if (!x) throw new Error('nothing applied to undo'); say(`undone: ${line(await changes.undo(x, { by: 'ruyix changes undo', redo: false }))}`) }
  else if (cmd === 'restore' && id) say(`undone: ${(await changes.restore(id, { by: 'ruyix changes restore', redo: false })).undone.join(', ')}`)
  else if (cmd === 'show' && id) { const v = await changes.get(id); say(`${line(v)}\n${v.diff.map(l => `  ${l}`).join('\n')}`) }
  else { console.error('usage: ruyix changes [show <id> | undo [<id>] | restore <id>]   (a proposal is applied on ruyix\'s page)'); process.exit(2) }
} catch (err) { sayErr(`ruyix changes: ${err.message}`); process.exit(1) }
