import { createHash } from 'node:crypto'
import { checkFeedback, latestFeedback, learnPreferences, optionsFor } from './preferences.js'

const bad = (code, text) => { throw Object.assign(new Error(text), { code }) }
const fingerprint = data => createHash('sha256').update(JSON.stringify(data)).digest('hex')

export function feedbackTargets(run) {
  if (!run) return []
  const stages = (run.stages || []).filter(s => ['passed', 'failed'].includes(s.status) || (run.status === 'waiting' && s.key === run.stage))
  const targets = stages.map(s => ({
    stage: s.key, title: s.title || s.key, status: s.status,
    summary: String(run.outputs?.[s.key]?.summary || s.result?.summary || s.note || '').slice(0, 3000),
    revision: fingerprint([run.id, s.key, s.attempt, s.status, s.version, run.outputs?.[s.key], s.result, run.edits, s.endedAt, run.contentRevision, run.reviews?.[s.key]?.version, run.reviews?.[s.key]?.round]),
  }))
  if (['done', 'failed', 'cancelled', 'interrupted'].includes(run.status)) targets.unshift({
    stage: '$final', title: { zh: '最终结果', en: 'Final result' }, status: run.status,
    summary: String(run.verdict?.reason || '').slice(0, 3000),
    revision: fingerprint([run.id, run.status, run.verdict, run.outputs, run.stages, run.edits, run.endedAt, run.contentRevision, Object.entries(run.reviews || {}).map(([key, r]) => [key, r.version, r.round])]),
  })
  return targets
}

export function studioFeedback({ storeOf, workbench, changed }) {
  const readRun = (studio, id) => {
    storeOf(studio)
    const run = workbench()?.run?.(String(id))
    if (!run || run.studio?.id !== studio) bad('noStudioRun', 'This run does not belong to this studio')
    return run
  }
  const workflowOf = run => run ? workbench()?.workflowOf?.(run) || null : null
  // Older ratings may lack workflow metadata. Only the actual historical run can recover that identity.
  const workflowId = row => (typeof row.workflow === 'string' && row.workflow) || workflowOf(workbench()?.run?.(row.run))?.id || null
  const historicalWorkflow = (id, rows) => {
    for (const row of rows) {
      if (workflowId(row) !== id) continue
      const workflow = workflowOf(workbench()?.run?.(row.run))
      if (workflow?.id === id) return workflow
    }
    return workflowOf({ template: id })
  }
  const profile = (studio, { profile: persona = null, workflow } = {}) => {
    const s = storeOf(studio)
    const rows = s.feedback().filter(f => (f.profile || null) === persona)
    const overview = workflow === undefined
    if (workflow === undefined) {
      const ids = [...new Set(rows.map(workflowId).filter(Boolean))]
      // The no-run view is an overview, never a mixture of creative defaults from different workflows.
      if (ids.length === 1) workflow = historicalWorkflow(ids[0], rows)
    }
    const scoped = workflow?.id ? rows.filter(f => workflowId(f) === workflow.id) : []
    const learned = learnPreferences(scoped, { enabled: s.note('preferences:enabled') !== 'false', revision: s.rev(), options: optionsFor(workflow) })
    return { ...learned, ...(overview && !workflow && { sampleCount: latestFeedback(rows).length }), profile: persona, workflow: workflow?.id || null }
  }
  return {
    preferences: profile,
    feedbackView(studio, runId) {
      const s = storeOf(studio)
      const runs = workbench()?.runsOf?.({ studio, limit: 100 })?.runs || []
      const run = runId ? readRun(studio, runId) : null
      const workflow = run ? workflowOf(run) : undefined, preferences = profile(studio, { profile: run?.account?.id || null, workflow })
      return { run: runId || null, runs: runs.map(r => ({ id: r.id, title: r.title, status: r.status })), targets: feedbackTargets(run),
        feedback: latestFeedback(s.feedback({ run: runId || null })), profile: preferences, options: optionsFor(run ? workflow : preferences.workflow && historicalWorkflow(preferences.workflow, s.feedback())) }
    },
    rate(studio, input) {
      const run = readRun(studio, input?.run)
      const target = feedbackTargets(run).find(t => t.stage === input.stage)
      if (!target) bad('noFeedbackTarget', 'This step has no reviewable result yet')
      if (input.revision !== target.revision) bad('feedbackChanged', 'The result changed since you opened it. Reload before scoring.')
      const workflow = workflowOf(run), data = checkFeedback(input, optionsFor(workflow))
      const feedback = storeOf(studio).putFeedback({ ...data, run: run.id, stage: target.stage, revision: target.revision,
        project: run.studio?.record ? `${run.studio.collection}:${run.studio.record}` : run.id,
        title: run.subject?.title || run.id, workflow: workflow?.id || run.template, profile: run.account?.id || null })
      changed(studio, null)
      return { feedback, profile: profile(studio, { profile: run.account?.id || null, workflow }) }
    },
    removeFeedback(studio, id) {
      const store = storeOf(studio), rows = store.feedback(), target = latestFeedback(rows).find(f => f.id === String(id))
      // Retracting a legacy duplicated target must not resurrect an older active revision as its current opinion.
      let removed = false
      if (target) for (const f of rows.filter(f => f.run === target.run && f.stage === target.stage)) removed = store.removeFeedback(f.id) || removed
      if (removed) changed(studio, null)
      return { removed, profile: profile(studio) }
    },
    setLearning(studio, enabled) {
      if (typeof enabled !== 'boolean') bad('badFeedback', 'Learning must be enabled or disabled')
      storeOf(studio).setPreferenceLearning(enabled)
      changed(studio, null)
      return profile(studio)
    },
  }
}
