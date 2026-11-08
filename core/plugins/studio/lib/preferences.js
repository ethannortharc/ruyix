// Explicit feedback only. A star rating measures quality; it cannot tell us *why* someone liked a result.
// Structured choices name what to do next. Two different records/runs must agree before a default is promoted.
export const PREFERENCE_OPTIONS = {
  detail: { label: { zh: '详略', en: 'Detail' }, values: { concise: '简洁 / Concise', balanced: '适中 / Balanced', thorough: '深入 / Thorough' } },
  tone: { label: { zh: '表达', en: 'Tone' }, values: { direct: '直接 / Direct', narrative: '叙事 / Narrative', technical: '技术 / Technical' } },
  evidence: { label: { zh: '来源展示', en: 'Sources' }, values: { inline: '正文标注 / Inline citations', appendix: '文末清单 / Source appendix' } },
  pacing: { label: { zh: '剪辑节奏', en: 'Pacing' }, values: { brisk: '紧凑 / Brisk', balanced: '适中 / Balanced', relaxed: '舒缓 / Relaxed' } },
  captions: { label: { zh: '字幕', en: 'Captions' }, values: { always: '尽量提供 / Prefer captions', minimal: '少量 / Minimal captions' } },
}

// Capabilities belong to the resolved workflow, including a custom workflow's inherited base contract.
// An unavailable workflow cannot safely advertise structured choices; scores and written feedback still work.
export const optionsFor = workflow => {
  const keys = workflow?.id ? workflow.preferenceOptions ?? ['detail', 'tone', 'evidence'] : []
  return Object.fromEntries(Object.entries(PREFERENCE_OPTIONS).filter(([key]) => keys.includes(key)))
}
const allowed = (options, key, value) => typeof value === 'string' && Object.hasOwn(options, key) && Object.hasOwn(options[key].values, value)

// Old releases kept several active revisions for one target. Keep their audit rows, but count only its latest rating.
export function latestFeedback(feedback) {
  const seen = new Set()
  return [...feedback].sort((a, b) => b.at - a.at || b.seq - a.seq).filter(f => {
    const key = JSON.stringify([f.run, f.stage])
    if (seen.has(key)) return false
    seen.add(key); return true
  })
}

export function checkFeedback(input, options = PREFERENCE_OPTIONS) {
  const bad = message => { throw Object.assign(new Error(message), { code: 'badFeedback' }) }
  if (!Number.isInteger(input?.score) || input.score < 1 || input.score > 5) bad('Choose a score from 1 to 5')
  if (input.note != null && (typeof input.note !== 'string' || input.note.length > 2000)) bad('Feedback is at most 2000 characters')
  const choices = input.choices ?? {}
  if (!choices || typeof choices !== 'object' || Array.isArray(choices)) bad('Preference choices must be an object')
  for (const [key, value] of Object.entries(choices)) {
    if (!allowed(options, key, value)) bad(`Unknown preference ${key}`)
  }
  return { score: input.score, note: (input.note || '').trim(), choices: { ...choices } }
}

export function learnPreferences(feedback, { enabled = true, revision = 0, now = Date.now(), options = PREFERENCE_OPTIONS } = {}) {
  feedback = latestFeedback(feedback)
  // Repeated scoring, revisions and intermediate steps from one project are one vote per dimension/scope.
  const votes = new Map()
  for (const f of feedback) {
    for (const [key, value] of Object.entries(f.choices || {})) {
      if (!allowed(options, key, value)) continue // Historical incompatible/invalid options never become defaults.
      const scope = f.stage === '$final' ? '*' : f.stage
      const identity = JSON.stringify([scope, key, f.project || f.run])
      if (!votes.has(identity)) votes.set(identity, { scope, key, value, at: f.at, feedback: f.id })
    }
  }
  const groups = new Map()
  for (const v of votes.values()) {
    const key = `${v.scope}:${v.key}`, g = groups.get(key) || { scope: v.scope, key: v.key, values: new Map(), total: 0 }
    // Ninety-day half life: later corrections eventually displace old preferences without erasing their history.
    const weight = Math.pow(0.5, Math.max(0, now - v.at) / (90 * 864e5))
    const value = g.values.get(v.value) || { value: v.value, weight: 0, support: 0, feedback: [] }
    value.weight += weight; value.support++; value.feedback.push(v.feedback); g.total += weight
    g.values.set(v.value, value); groups.set(key, g)
  }
  const rules = [], candidates = []
  for (const g of groups.values()) {
    const winner = [...g.values.values()].sort((a, b) => b.weight - a.weight || a.value.localeCompare(b.value))[0]
    const confidence = Number((winner.weight / g.total).toFixed(3))
    const rule = { scope: g.scope, key: g.key, value: winner.value, support: winner.support, confidence, feedback: winner.feedback }
    ;(winner.support >= 2 && confidence >= 0.67 ? rules : candidates).push(rule)
  }
  // Bound each source scope before the brief filters for its consumer. Unrelated stages cannot evict its notes.
  const counts = new Map(), examples = []
  if (enabled) for (const f of feedback) {
    const scope = f.stage === '$final' ? '*' : f.stage, count = counts.get(scope) || 0
    if (!f.note || count >= 4) continue
    counts.set(scope, count + 1)
    examples.push({ id: f.id, scope, score: f.score, note: f.note, title: f.title, revision: f.revision })
  }
  return { version: 1, revision, enabled, sampleCount: feedback.length, rules: enabled ? rules : [], candidates, examples, updatedAt: now }
}
