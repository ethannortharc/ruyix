#!/usr/bin/env node
// ruyix desk — how this Ruyix looks as a desktop (desktop.json), from a shell: for the person, and for any agent with a
// shell here (Claude Code, Codex, a script) the way dsh's agents have their surface tools. It reads, and it proposes;
// the person applies a proposal on Ruyix's page (the card at the bottom right, or Settings → Changes) — an agent's shell
// could run this command too (as `ruyix changes`, it never applies one).
//   ruyix desk                          the desktop now: its theme, every key, the file
//   ruyix desk keys                     what each key takes
//   ruyix desk themes                   the themes
//   ruyix desk theme <id>               propose a theme (its wallpaper, accent, tint and corners together)
//   ruyix desk set <key>=<value> …      propose keys (a value is JSON when it reads as JSON: true, 1.1, null, [...])
//   ruyix desk widget add <type> [sm|md] | remove <id or type>   propose a widget on the desk, or one less
//   ruyix desk reset                    propose the defaults
//   ruyix desk undo [<change id>]       propose the reverse of a change (without an id: the last one applied)
// Options for a proposal: --summary "<what it is, in the person's language>", --wait [seconds] (until it is applied or
// discarded; 120 without a number).
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DESKTOP_DEFAULT, MAX_WIDGETS, THEMES, WIDGET_SIZES, checkDesktop, desktopKeys, themeOf, themePatch } from '../desktop.js'
import { createChanges } from '../surfaces.js'

// what a change says is shown, never run: a terminal's control characters and the marks that turn text around as \u escapes
const shown = v => String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
const say = v => console.log(shown(v))
const home = process.env.RUYIX_HOME || join(homedir(), '.ruyix'), file = join(home, 'desktop.json')
const changes = createChanges({ home })
const USAGE = 'usage: ruyix desk [keys | themes | theme <id> | set <key>=<value> … | widget add <type> [sm|md] | widget remove <id> | reset | undo [<id>]] [--summary "…"] [--wait [s]]'

// the options, then the words
const argv = process.argv.slice(2), words = [], opt = { summary: '', wait: 0 }
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--summary') opt.summary = argv[++i] || ''
  else if (argv[i] === '--wait') opt.wait = /^\d+$/.test(argv[i + 1] || '') ? Number(argv[++i]) : 120
  else words.push(argv[i])
}
const [cmd = 'show', ...rest] = words

/** The desktop as the file has it now (the defaults for what it leaves out); a broken file is said, never guessed at. */
function now() {
  let text = null
  try { text = readFileSync(file, 'utf8') } catch { return { ...DESKTOP_DEFAULT } }
  return checkDesktop(JSON.parse(text))
}
const value = v => { try { return JSON.parse(v) } catch { return v } }
const by = () => (process.env.RUYIX_BY ? `ruyix desk (${process.env.RUYIX_BY})` : 'ruyix desk')

async function propose(patch, summary) {
  const c = await changes.propose({ summary: opt.summary || summary, edits: [{ surface: 'desktop', value: patch }], by: by() })
  say(`proposed ${c.id}: ${c.summary}`)
  for (const l of c.diff) say(`  ${l}`)
  say('It waits for the person: the card at the bottom right of the Ruyix page (or Settings → Changes) — Apply, and the desktop changes at once.')
  if (!opt.wait) return
  const until = Date.now() + opt.wait * 1000
  for (;;) {
    const x = await changes.get(c.id)
    if (x.state !== 'proposed') { say(`${c.id}: ${x.state}`); process.exit(x.state === 'applied' ? 0 : 3) }
    if (Date.now() > until) { say(`${c.id}: still waiting after ${opt.wait}s`); process.exit(4) }
    await new Promise(r => setTimeout(r, 1000))
  }
}

try {
  if (cmd === 'show') {
    const d = now(), { theme, changed } = themeOf(d)
    say(`theme: ${theme ? `${theme.id} (${theme.en} · ${theme.zh})${changed.length ? `, with ${changed.join(', ')} changed` : ''}` : 'none'}`)
    for (const [k, v] of Object.entries(d)) if (k !== 'theme') say(`${k}: ${JSON.stringify(v)}`)
    say(`file: ${file}`)
    const waiting = (await changes.pending()).length
    if (waiting) say(`${waiting} proposed change(s) wait for the person (ruyix changes)`)
  } else if (cmd === 'keys') for (const l of desktopKeys()) say(l)
  else if (cmd === 'themes') {
    const cur = now().theme
    for (const th of THEMES) say(`${th.id === cur ? '*' : ' '} ${th.id.padEnd(10)} ${th.en} · ${th.zh} — wallpaper ${th.wallpaper}, accent ${th.accent}, tint ${th.tint}, corners ${th.corners}${th.appearance ? `, ${th.appearance}` : ''}`)
  } else if (cmd === 'theme' && rest[0]) {
    const patch = themePatch(rest[0])
    if (!patch) throw new Error(`no theme ${rest[0]}: ${THEMES.map(x => x.id).join(', ')}`)
    const th = THEMES.find(x => x.id === rest[0])
    await propose(patch, `Theme: ${th.en} · 主题：${th.zh}`)
  } else if (cmd === 'set' && rest.length) {
    const patch = {}
    for (const kv of rest) {
      const i = kv.indexOf('=')
      if (i < 1) throw new Error(`${kv}: give key=value (ruyix desk keys)`)
      patch[kv.slice(0, i)] = value(kv.slice(i + 1))
    }
    checkDesktop({ ...now(), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== null)) }) // said here, before a proposal
    await propose(patch, `Desktop: ${Object.entries(patch).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(', ')}`)
  } else if (cmd === 'widget' && rest[0] === 'add' && rest[1]) {
    const d = now(), size = rest[2] || 'md'
    if (!WIDGET_SIZES.includes(size)) throw new Error(`size: ${WIDGET_SIZES.join(' or ')}`)
    // the default set as a list of its own: its built-in part (a plugin's overviews are the page's to know)
    const list = d.widgets || [{ id: 'dsetup', type: 'setup', size: 'md' }, { id: 'dclock', type: 'clock', size: 'sm' }, { id: 'dcal', type: 'calendar', size: 'sm' }]
    if (list.length >= MAX_WIDGETS) throw new Error(`the desk has ${MAX_WIDGETS} widgets already`)
    let id = rest[1].replace(/[^a-z0-9]/g, '').slice(0, 9) || 'w'
    for (let n = 2; list.some(w => w.id === id); n++) id = `${id.slice(0, 9)}${n}`
    await propose({ widgets: [...list, { id, type: rest[1], size }] }, `Widget: ${rest[1]}`)
    if (!d.widgets) say('(the default set\'s plugin overviews are not in the list now: add one back with ruyix desk widget add overview:<section>)')
  } else if (cmd === 'widget' && rest[0] === 'remove' && rest[1]) {
    const list = now().widgets
    if (!list) throw new Error('the desk shows its default set: there is no list of its own to take one from (add one first, or edit the widgets on the desk)')
    const left = list.filter(w => w.id !== rest[1] && w.type !== rest[1])
    if (left.length === list.length) throw new Error(`no widget ${rest[1]} on the desk: ${list.map(w => `${w.id} (${w.type})`).join(', ')}`)
    await propose({ widgets: left }, `Widget removed: ${rest[1]}`)
  } else if (cmd === 'undo') {
    // the reverse of a change, proposed like any (the last applied one that touched the desktop, without an id)
    const id = rest[0] || (await changes.list({ limit: 200 })).find(c => c.state === 'applied' && c.files.includes('desktop.json'))?.id
    if (!id) throw new Error('nothing applied to undo')
    const c = await changes.proposeUndo(id, { summary: opt.summary, by: by() })
    say(`proposed ${c.id}: ${c.summary}`)
    for (const l of c.diff) say(`  ${l}`)
    say('It waits for the person: the card at the bottom right of the Ruyix page (or Settings → Changes).')
  } else if (cmd === 'reset') await propose(null, 'Desktop: the defaults · 桌面：恢复默认')
  else { console.error(USAGE); process.exit(2) }
} catch (err) { console.error(shown(`ruyix desk: ${err.message}`)); process.exit(1) }
