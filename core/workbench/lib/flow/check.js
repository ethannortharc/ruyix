// A script step read without running it: does it parse, which steps it names, which of its agents and installed scripts
// it asks for, and what it may not do (what would make a resumed run decide differently, what the realm does not have).
import * as vm from 'node:vm'
import { agentRoles, codeOf, scriptRefs, stepNames } from './names.js'

export const FLOW_MAX = 100_000

const NOT_HERE = [
  [/\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)|\bMath\s*\.\s*random\s*\(/, 'the clock and Math.random would make a resumed run decide differently: use wf.now()'],
  [/\brequire\s*\(|\bimport\s*\(|^\s*import\s/m, 'a workflow script has no modules: what it does goes through wf and its steps (s.agent, s.sh, s.script…)'],
  [/\bprocess\s*\.|\bfetch\s*\(|\bsetTimeout\s*\(|\bsetInterval\s*\(/, 'a workflow script has no process, network or timers: a command goes through s.sh inside a step'],
  [/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/, 'a workflow script cannot make code from text'],
]

/** → { errors: [text], steps, roles, scripts } */
export function checkFlow(source) {
  const src = String(source ?? '')
  const errors = []
  if (!src.trim()) errors.push('the script is empty: an async body over wf — await wf.step(\'name\', async s => …)')
  if (src.length > FLOW_MAX) errors.push(`the script is at most ${FLOW_MAX / 1000} KB`)
  // compiled, never run: a syntax error said with its line
  try { new vm.Script(`(async () => {\n${src}\n})()`, { filename: 'workflow-script', lineOffset: -1 }) } catch (e) { errors.push(`it does not parse: ${e.message}`) }
  // (what is code: a command or a prompt that mentions process.exit is text, not a call)
  const { code } = codeOf(src)
  for (const [re, why] of NOT_HERE) if (re.test(code)) errors.push(why)
  const steps = stepNames(src)
  if (src.trim() && !steps.length) errors.push('it names no step: the work goes in steps — await wf.step(\'name\', async s => …) — so a resumed run does not do it twice')
  if (/\.\s*agent\s*\(\s*[^'"`\s)]/.test(code)) errors.push('name the agent as text: s.agent(\'role\', prompt) — one of the step\'s agents')
  return { errors, steps, roles: agentRoles(src), scripts: scriptRefs(src) }
}
