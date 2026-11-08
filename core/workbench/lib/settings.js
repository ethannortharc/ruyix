// The workbench's home folder, its settings and the shell commands its steps run. Settings are the core's few keys plus
// one block per domain pack (settings.packs.<id>, the pack's own defaults); the person's overrides live in
// <home>/settings.json, secrets never do — settings name connections (the Connectors page holds them).
// Commands go through one injectable runner so check.mjs can fake them.
import { spawn } from 'node:child_process'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isModelRef } from './models.js'

// ~/.ruyix/workbench: workbench.db, runs/, settings.json, workflows/, scripts/, ui-runtime/ (the connectors' Playwright).
// RUYIX_WORKBENCH_HOME moves it (the self-check, a box).
export const HOME = process.env.RUYIX_WORKBENCH_HOME || join(homedir(), '.ruyix/workbench')
export const expand = p => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)

const CORE_DEFAULTS = {
  // The folder script steps with cwd "workspace" run in; empty: the run's own folder.
  workspace: '',
  // Who does a step: workflow → step → { agent, fallback ('' none), skills } — agents of Agent Hub's pool, where the
  // person picked other than the role's default (the workflow's roles).
  steps: {},
  // The model a model step uses when neither the step nor its role names one: "<connection>:<model>" or
  // "dsh:<provider>/<model>" (lib/models.js). Empty: such a step must name its own.
  model: '',
  // Base steps that can be left out, turned off for every run: key → false. (A step is optional when its workflow says so.)
  stages: {},
  agentTimeoutMinutes: 60,
  // The standing conversation: after idleHours of quiet the next message starts a new session, told the summary of the
  // last; entries older than keepDays keep their words and lose the rest (tool calls, a board's rows); maxTasks: how many
  // background tasks it may have going at once; answerOpen: how an answer comes out on the desk — a leaf from the main
  // agent's strip, into the drawer, or a window in front (docs/design/desk-answers.md).
  chat: { idleHours: 6, keepDays: 90, maxTasks: 3, answerOpen: 'leaf' },
  // After a dsh restart, runs it cut short resume on their own (within maxAgeHours, at most maxPerRun times each).
  autoResume: { enabled: true, maxAgeHours: 6, maxPerRun: 2 },
  // One block per domain pack: settings.packs.<id>, starting from the pack's own `settings`.
  packs: {},
}

/** The settings everything starts from: the core's, and each pack's own under packs.<id>. */
export const defaultsOf = (packs = []) => ({ ...CORE_DEFAULTS, packs: Object.fromEntries(packs.map(p => [p.id, structuredClone(p.settings || {})])) })

const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
// a map of its own (any key inside), not a fixed shape: steps and stages, and any block the defaults leave empty
const FREE = new Set(['steps', 'stages'])
const free = (base, k, path) => (!path && FREE.has(k)) || (isObj(base[k]) && !Object.keys(base[k]).length)
const merge = (base, over, path = '') => Object.fromEntries(Object.keys(base).map(k => [k, free(base, k, path) ? (isObj(over?.[k]) ? over[k] : base[k]) : isObj(base[k]) ? merge(base[k], isObj(over?.[k]) ? over[k] : {}, `${path}${k}.`) : over?.[k] ?? base[k]]))
const diff = (base, value, path = '') => Object.fromEntries(Object.keys(base).flatMap(k => {
  if (!free(base, k, path) && isObj(base[k])) { const d = diff(base[k], value[k], `${path}${k}.`); return Object.keys(d).length ? [[k, d]] : [] }
  return JSON.stringify(base[k]) === JSON.stringify(value[k]) ? [] : [[k, value[k]]]
}))
/** Same shape and types as the defaults, or a message naming the first bad key. */
const check = (base, value, path = '') => {
  if (!isObj(value)) return `${path ? path.slice(0, -1) : 'settings'} must be an object`
  for (const k of Object.keys(value)) {
    if (!Object.hasOwn(base, k)) return `unknown setting ${path}${k}`
    const b = base[k], v = value[k]
    const bad = !path && k === 'steps' ? checkSteps(v)
      : !path && k === 'model' ? (typeof v !== 'string' || (v && !isModelRef(v))) && 'model is "<connection>:<model>" or "dsh:<provider>/<model>" (or empty)'
      : !path && k === 'stages' ? checkStages(v)
        : isObj(b) ? (free(base, k, path) ? !isObj(v) && `${path}${k} must be an object` : check(b, v, `${path}${k}.`))
          : Array.isArray(b) ? (!Array.isArray(v) || v.some(x => typeof x !== 'string')) && `${path}${k} must be a list of strings` : typeof v !== typeof b && `${path}${k} must be a ${typeof b}`
    if (bad) return bad
  }
  return ''
}
const KEY = /^[a-z][a-z0-9_.-]*$/, AGENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/, SKILL = /^(?:[a-z0-9][a-z0-9-]{1,40}\/)?[\w.-]{1,64}$/
const plainKey = k => KEY.test(k) && !['constructor', 'prototype', '__proto__'].includes(k)
const checkStages = v => (!isObj(v) || Object.entries(v).some(([k, x]) => !plainKey(k) || typeof x !== 'boolean') ? 'stages turns each optional step on or off' : '')
/** workflow → step → { agent, fallback, skills }: ids only (whether those agents exist is the settings op's check). */
const checkSteps = v => {
  if (!isObj(v)) return 'steps must be an object'
  for (const [wf, steps] of Object.entries(v)) {
    if (!plainKey(wf) || !isObj(steps)) return 'steps maps each workflow to its steps'
    for (const [key, pick] of Object.entries(steps)) {
      if (!plainKey(key) || !isObj(pick)) return `steps.${wf}: each step maps to { agent, fallback, skills } or { model }`
      for (const [f, x] of Object.entries(pick)) {
        const ok = f === 'agent' ? typeof x === 'string' && AGENT.test(x)
          : f === 'fallback' ? x === '' || x === null || (typeof x === 'string' && AGENT.test(x))
            : f === 'skills' ? Array.isArray(x) && x.length <= 10 && x.every(r => typeof r === 'string' && SKILL.test(r))
              : f === 'model' ? typeof x === 'string' && isModelRef(x) : false
        if (!ok) return `steps.${wf}.${key}.${f}: ${f === 'skills' ? 'up to 10 skills (pack/skill)' : ['agent', 'fallback'].includes(f) ? 'an agent id' : f === 'model' ? 'a model, "<connection>:<model>" or "dsh:<provider>/<model>"' : 'unknown field'}`
      }
    }
  }
  return ''
}
// What the file says about packs that are not loaded now stays as it is: their settings come back with them.
const stray = (mine, packs) => Object.fromEntries(Object.entries(isObj(mine?.packs) ? mine.packs : {}).filter(([id]) => !packs.some(p => p.id === id)))
const mergeAll = (mine, packs) => {
  const s = merge(defaultsOf(packs), mine)
  Object.assign(s.packs, stray(mine, packs))
  return s
}

/** A missing state file starts empty; damaged or unreadable state is preserved and reported. */
export function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObj(value)) throw new Error('expected an object')
    return value
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw Object.assign(new Error(`cannot read ${file}: ${err.message}; keep the file and repair it before saving`), { code: 'badState', cause: err })
  }
}
/** Write the complete, flushed file before replacing its previous state. */
export function writeState(file, value) {
  if (!isObj(value)) throw new Error('state must be an object')
  readState(file) // refuse to overwrite an existing file whose state could not be read
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, file)
  } finally { rmSync(tmp, { force: true }) }
}

export function settingsFile(dir = HOME) { return join(dir, 'settings.json') }
export function loadSettings(file = settingsFile(), packs = []) {
  const mine = readState(file)
  return mergeAll(isObj(mine) ? mine : {}, packs)
}
export function saveSettings(value, file = settingsFile(), packs = []) {
  if (!isObj(value)) throw new Error('settings must be an object')
  const known = defaultsOf(packs)
  const { packs: theirs, ...core } = value
  const here = Object.fromEntries(Object.entries(isObj(theirs) ? theirs : {}).filter(([id]) => packs.some(p => p.id === id)))
  const bad = check({ ...known, packs: {} }, core) || (theirs !== undefined && !isObj(theirs) ? 'packs must be an object' : check(known.packs, here, 'packs.'))
  if (bad) throw new Error(bad)
  const next = mergeAll(value, packs)
  if (!(next.agentTimeoutMinutes >= 1 && next.agentTimeoutMinutes <= 24 * 60)) throw new Error('agentTimeoutMinutes must be 1–1440')
  if (!(next.chat.idleHours > 0 && next.chat.idleHours <= 24 * 30 && next.chat.keepDays >= 1 && next.chat.keepDays <= 3650 && Number.isInteger(next.chat.maxTasks) && next.chat.maxTasks >= 1 && next.chat.maxTasks <= 10)) throw new Error('chat: idleHours is above 0 (up to 720), keepDays 1–3650 and maxTasks 1–10')
  if (!['leaf', 'drawer', 'window'].includes(next.chat.answerOpen)) throw new Error('chat: answerOpen is leaf, drawer or window')
  if (!(next.autoResume.maxAgeHours > 0 && next.autoResume.maxPerRun >= 0)) throw new Error('autoResume: maxAgeHours must be above 0 and maxPerRun 0 or more')
  mkdirSync(join(file, '..'), { recursive: true })
  const mine = diff(known, next)
  const out = { ...mine, ...(Object.keys(stray(next, packs)).length && { packs: { ...mine.packs, ...stray(next, packs) } }) }
  writeState(file, out)
  return next
}

/**
 * Run a command; never rejects. `code` -1 = could not start, 124 = timed out, 130 = stopped (`signal`). With a signal it
 * runs in a process group of its own (not on Windows): a stop — or its time running out — ends what it started too, not
 * only the command, and it is over once nothing of that group is left (SIGTERM, then SIGKILL after 3 s).
 */
export function sh(cmd, args, { cwd, env, input, timeout = 120000, signal, max = 8 << 20 } = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let stdout = '', stderr = '', timedOut = false, stopped = false, settled = false, hard = null
    let child
    const group = !!signal && process.platform !== 'win32'
    try {
      child = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env, windowsHide: true, ...(group ? { detached: true } : signal && { signal }) })
    } catch (err) {
      return resolve({ code: -1, stdout, stderr: err.message, ms: 0 })
    }
    const kill = sig => { try { if (group && child.pid) process.kill(-child.pid, sig); else child.kill(sig) } catch { /* already gone */ } }
    // (is anything of the group left: what the command started, outliving it)
    const alive = () => { if (!group || !child.pid) return false; try { process.kill(-child.pid, 0); return true } catch { return false } }
    let ended = null, killed = false // the command's end, kept while a stopped group is still being killed; killed hard already
    const timer = setTimeout(() => { timedOut = true; kill('SIGKILL') }, timeout)
    const stop = () => { stopped = true; kill('SIGTERM'); hard = setTimeout(() => { kill('SIGKILL'); killed = true; if (ended) setTimeout(ended, 100) }, 3000) }
    if (group) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }) }
    const finish = (code, extra = '') => {
      if (settled) return
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(hard)
        signal?.removeEventListener?.('abort', stop)
        resolve({ code: timedOut ? 124 : stopped ? 130 : code, stdout, stderr: stderr + extra + (timedOut ? `\n(timed out after ${timeout / 1000}s)` : stopped ? '\n(stopped)' : ''), ms: Date.now() - started })
      }
      // stopped: over once nothing of what it started is left (the group killed hard if it must be)
      if (stopped && !killed && alive()) ended = done
      else done()
    }
    child.stdout.on('data', d => { if (stdout.length < max) stdout += d })
    child.stderr.on('data', d => { if (stderr.length < max) stderr += d })
    child.on('error', err => finish(-1, err.message))
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 : -1)))
    child.stdin.on('error', () => {})
    child.stdin.end(input ?? '')
  })
}
