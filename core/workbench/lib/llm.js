// One model call, text in → text out, through dsh's LLM service (provider/model as configured in Settings).
// Every call's usage goes to `onCall` — the workbench's log of the model calls it makes itself (lib/aiwork.js callLog) —
// and never breaks the call when the log does.
import { randomUUID } from 'node:crypto'

/** Report one call to `onCall` (if any): { at, kind, model, ms, ok, usage, error?, by? }; a listener that throws is ignored. */
export function noteCall(onCall, entry) {
  try { onCall?.(entry) } catch { /* the log never breaks a call */ }
}

export async function complete({ llm, model, system, text, kind, maxTokens = 8192, signal, onCall, by }) {
  const cut = model.indexOf('/')
  if (cut < 1) throw new Error(`the model must be provider/model, got "${model}"`)
  const t0 = Date.now()
  let out = '', finish = null, usage = null
  const note = error => noteCall(onCall, { at: t0, kind, model, ms: Date.now() - t0, ok: !error, usage, ...(by && { by }), ...(error && { error: String(error.message || error).slice(0, 300) }) })
  try {
    for await (const c of llm.stream({
      provider: model.slice(0, cut), model: model.slice(cut + 1), system, maxTokens, signal,
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind } }],
    })) {
      if (c.type === 'text-delta') out += c.text
      if (c.type === 'usage') usage = c.usage
      if (c.type === 'finish') finish = c.reason
    }
    if (finish && finish.kind !== 'stop') throw new Error(`the model stopped: ${finish.kind}${finish.failure?.message ? ` — ${finish.failure.message}` : ''}`)
  } catch (err) { note(err); throw err }
  note(null)
  return out
}
