import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { actions as commonActions, header, intake, renderReport, report, subjectText } from '@ruyix/workbench/common'
import { personStep } from '@ruyix/workbench/person'
import { digest, folderOf, inside, readJson, writeFile, writeJson } from './lib/files.js'
import { dependencies, ingest, recordFile, render } from './lib/media.js'
import { durationOf, initialTimeline, subtitles, validateTimeline } from './lib/timeline.js'

export const ID = 'video'
export const DEFAULTS = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }
const L = (en, zh) => ({ en, zh })
const sourcesOf = run => run.video?.sources || []
const timelineOf = run => validateTimeline(readJson(run, 'timeline.json'), sourcesOf(run))
const sourceDigest = run => digest(sourcesOf(run).map(s => ({ id: s.id, sha256: s.sha256 })))
const editDigest = run => digest({ timeline: timelineOf(run), sources: sourceDigest(run) })
const locks = new WeakMap()
const locksFor = store => { if (!locks.has(store)) locks.set(store, { saves: new Set(), edits: new Set() }); return locks.get(store) }
const savesFor = store => locksFor(store).saves
const changed = message => Object.assign(new Error(message), { code: 'changedMeanwhile' })
const fileKey = path => {
  const full = resolve(path)
  let parent = full
  while (!existsSync(parent) && parent !== dirname(parent)) parent = dirname(parent)
  return resolve(realpathSync(parent), relative(parent, full)).toLowerCase()
}
export function beforeFileMutation({ run, kind, path, by, store }) {
  const lock = locksFor(store), id = run.id
  if (kind !== 'edit') {
    if (lock.saves.has(id) || lock.edits.has(id)) throw changed('Wait for the timeline edit to finish before restarting')
    return
  }
  const root = folderOf(run), target = fileKey(resolve(root, String(path ?? '').trim().replace(/\\/g, '/'))), outputs = fileKey(resolve(root, 'exports'))
  if (target === outputs || target.startsWith(outputs + sep)) throw new Error('Rendered exports are read-only. Edit captions and cuts in timeline.json, then render and review the video again.')
  if (target !== fileKey(resolve(root, 'timeline.json'))) return
  if (lock.edits.has(id) || (lock.saves.has(id) && by !== 'video')) throw changed('The timeline is being edited in another view. Wait and reload before saving.')
  if (by === 'video' && lock.saves.has(id)) return
  lock.edits.add(id)
  return () => lock.edits.delete(id)
}
const keepJson = (w, name, value) => {
  writeJson(w.run, name, value)
  return w.evidence({ kind: 'file', title: name, input: { path: name, mime: 'application/json' }, output: JSON.stringify(value).slice(0, 1500), full: `${JSON.stringify(value, null, 2)}\n`, name, ok: true })
}

const inspect = {
  key: 'inspect', owner: 'system', title: 'Inspect source footage',
  async run(w) {
    const toolchain = await dependencies(w.packSettings, w.signal)
    const sources = await ingest(w.run, { settings: w.packSettings, signal: w.signal })
    keepJson(w, 'sources.json', { toolchain, sources })
    w.update(r => ({ ...r, video: { ...r.video, sources, toolchain, preview: null, export: null, approvedPreview: null } }))
    return { ok: true, note: `${sources.length} source video(s), ${Math.round(sources.reduce((sum, s) => sum + s.duration, 0))} seconds; checksums recorded` }
  },
}
const skill = readFileSync(fileURLToPath(new URL('./skills/video-editing/SKILL.md', import.meta.url)), 'utf8')
const plan = {
  key: 'plan', owner: 'editor', title: 'Plan the edit',
  validate(result, c) { timelineOf(c.run); if (!String(result.summary || '').trim()) throw new Error('summary is required') },
  async run(w) {
    const sources = sourcesOf(w.run), fields = w.run.subject?.fields || {}
    let timeline = existsSync(inside(folderOf(w.run), 'timeline.json')) ? timelineOf(w.run) : initialTimeline(sources, { title: w.run.subject?.title, aspect: fields.aspect, duration: fields.targetSeconds })
    writeJson(w.run, 'timeline.json', timeline)
    if (fields.assisted) {
      await w.agent('editor', [header(w, 'plan'), subjectText(w), skill,
        `Read sources.json and the current timeline.json. Inspect footage before making content-specific choices; if you cannot inspect it, keep the initial assembly and clearly state that limitation in edit-notes.md. Never invent a transcript or claim you watched footage you did not inspect. Honor the person's review notes and preference snapshot.`,
        `Write a complete timeline.json using this exact schema: ${JSON.stringify(timeline)}. You may trim, reorder, duplicate or remove clips, change speed (0.5–2), volume (0–2), output fit (contain/cover), fps (24/25/30/50/60), and add timestamped captions ONLY from provided/verified speech. Output start/end caption seconds use the final frame clock. Source ids must come from sources.json; no file paths, commands or filters in the timeline. Stable unique clip and caption ids. Keep output at most 30 minutes, 100 clips, 1000 cues. Do not modify sources.json or source footage. Save edit-notes.md with cut rationale and unresolved questions. Finish with stage_result({summary}).`,
      ].join('\n\n'), { title: 'Plan the edit' })
      timeline = timelineOf(w.run)
    }
    keepJson(w, 'timeline.json', timeline)
    w.update(r => ({ ...r, video: { ...r.video, timelineSha256: digest(timeline), preview: null, export: null, approvedPreview: null } }))
    return { ok: true, note: `${timeline.clips.length} clips, ${durationOf(timeline).toFixed(2)} seconds${fields.assisted ? '' : ' — initial assembly ready for your edit'}` }
  },
}
const review = {
  key: 'review', owner: 'system', person: 'review', title: 'Review the timeline',
  run: w => personStep(w, { id: 'review', title: '审核剪辑时间线', ask: 'review', back: 'plan', revisedBy: false, show: ['timeline.json', 'edit-notes.md'], display: 'video.timeline',
    text: '逐段调整素材、入点、出点、速度、音量和顺序。保存后批准，将渲染一份真正可播放的预览；你可以在预览处继续提修改意见。' }),
}
async function renderStep(w, preview) {
  const timeline = timelineOf(w.run)
  const seen = w.run.video?.preview
  if (!preview && (!seen || seen.timelineSha256 !== digest(timeline) || seen.sourceSha256 !== sourceDigest(w.run) || w.run.video?.approvedPreview !== seen.sha256)) return { ok: false, goto: 'preview', note: 'The edit changed; render and review its preview again before exporting' }
  // Older evidence stays available in history, but a resumed/failed render must not present it as the new result.
  w.update(r => ({ ...r, video: { ...r.video, ...(preview ? { preview: null, export: null, approvedPreview: null } : { export: null }) } }))
  const result = await render(w.run, timeline, sourcesOf(w.run), { preview, settings: w.packSettings, signal: w.signal })
  const file = await recordFile(w, result.name, result.path, w.signal)
  if (file.sha256 !== result.sha256) throw new Error('The rendered file changed while recording it; render again before reviewing')
  const manifest = await recordFile(w, result.manifestName, inside(folderOf(w.run), result.manifestName, { file: true }), w.signal)
  let caption = null
  if (timeline.captions.length) {
    const name = `${result.name}.vtt`, path = writeFile(w.run, name, subtitles(timeline))
    caption = await recordFile(w, name, path, w.signal)
  }
  const saved = { name: result.name, seq: file.seq, manifestSeq: manifest.seq, captionSeq: caption?.seq, sha256: result.sha256, timelineSha256: result.timelineSha256, sourceSha256: sourceDigest(w.run), bytes: result.bytes, info: result.info }
  w.update(r => ({ ...r, video: { ...r.video, [preview ? 'preview' : 'export']: saved } }))
  return { ok: true, note: `${preview ? 'Preview' : 'Export'}: ${result.info.width}×${result.info.height}, ${result.info.duration.toFixed(2)}s; full decode QA passed` }
}
const preview = { key: 'preview', owner: 'system', title: 'Render preview', run: w => renderStep(w, true) }
const previewReview = {
  key: 'preview-review', owner: 'system', person: 'review', title: 'Review the playable preview',
  async run(w) {
    const out = await personStep(w, { id: 'preview-review', title: '播放并审核预览', ask: 'review', back: 'plan', revisedBy: false, display: 'video.timeline',
      text: '播放实际渲染的 MP4，检查每个剪辑点前后、画面裁切、对白完整性和字幕同步。批准后才制作全分辨率成片；修改时间线请退回剪辑步骤。' })
    if (out.ok) {
      const now = digest(timelineOf(w.run))
      if (now !== w.run.video?.preview?.timelineSha256) return { ok: false, goto: 'preview', note: 'Timeline changed while reviewing; render a fresh preview' }
      w.update(r => ({ ...r, video: { ...r.video, approvedPreview: r.video.preview.sha256 } }))
    }
    return out
  },
}
const exportStage = { key: 'export', owner: 'system', title: 'Export full-resolution MP4', run: w => renderStep(w, false) }
const finalReview = {
  key: 'final-review', owner: 'system', person: 'review', title: 'Review the final video',
  async run(w) {
    const out = await personStep(w, { id: 'final-review', title: '审核最终成片', ask: 'review', back: 'plan', revisedBy: false, display: 'video.timeline',
      text: '检查最终 MP4，下载视频、字幕和可复现清单。可以对最终结果及前面的剪辑步骤评分；批准后项目标记为可交付。这里不会自动对外发布。' })
    if (out.ok && digest(timelineOf(w.run)) !== w.run.video?.export?.timelineSha256) return { ok: false, goto: 'preview', note: 'The timeline changed; review its new preview before delivering' }
    return out
  },
}
export function opsOf({ engine, store, failWith }) {
  const runOf = id => { const run = engine.get(String(id || '')); if (!run || run.template !== 'video.edit') throw failWith('noRun', { id }, 'No video editing run'); return run }
  const view = run => ({ sources: sourcesOf(run).map(({ id, name, duration, width, height, audio, fps, evidence }) => ({ id, name, duration, width, height, audio, fps, evidence })), timeline: timelineOf(run), digest: editDigest(run), preview: run.video?.preview, export: run.video?.export, editable: run.status === 'waiting' && run.stages?.find(s => s.key === 'review')?.status === 'running' })
  const saving = savesFor(store)
  return {
    timeline: ({ run }) => view(runOf(run)),
    async saveTimeline({ run, timeline, expectedDigest }) {
      const id = String(run)
      if (saving.has(id) || locksFor(store).edits.has(id)) throw changed('A timeline edit is already in progress. Wait and reload before saving.')
      saving.add(id)
      try {
        const r = runOf(id)
        const active = store.list('approval').find(a => a.runId === id && a.payload?.stage === 'review' && ['pending', 'failed'].includes(a.status))
        if (r.status !== 'waiting' || !active) throw new Error('Return to the timeline review step before changing the edit')
        // The pack lease keeps product edits out while the blob and digest are read; versions.edit checks the blob
        // again inside its serial write queue, so an already queued write cannot silently replace this base.
        const { blob } = await engine.versions.show(r, 'WORK', 'timeline.json')
        if (expectedDigest !== editDigest(r)) throw changed('The timeline changed in another view. Reload before saving your edits.')
        const next = validateTimeline(timeline, sourcesOf(r))
        await engine.editFile(id, { path: 'timeline.json', content: `${JSON.stringify(next, null, 2)}\n`, blob, by: 'video' })
        const now = engine.get(id)
        if (now.status !== 'waiting' || !store.list('approval').some(a => a.id === active.id && ['pending', 'failed'].includes(a.status))) throw new Error('The review was stopped while saving; reopen the timeline review before continuing')
        store.put('run', { ...now, video: { ...now.video, timelineSha256: digest(next), preview: null, export: null, approvedPreview: null } })
        return view(engine.get(id))
      } finally { saving.delete(id) }
    },
  }
}
export function createPack() {
  return {
    id: ID, name: L('Video · edit and deliver', 'Video · 视频剪辑'), settings: DEFAULTS, beforeFileMutation,
    async setup(settings) { try { await dependencies(settings); return [{ id: 'video-ffmpeg', required: true, ready: true, title: L('FFmpeg video export', 'FFmpeg 视频导出'), detail: L('FFmpeg, ffprobe, H.264 and AAC are ready', 'FFmpeg、ffprobe、H.264 和 AAC 已就绪') }] } catch (e) { return [{ id: 'video-ffmpeg', required: true, ready: false, title: L('Install FFmpeg', '安装 FFmpeg'), detail: L(e.message, e.message) }] } },
    text: { header: () => 'This is a local video editing run. sources.json is inspected media, timeline.json is a declarative EDL. Source footage is read-only. Only the bounded native renderer exports media. The person reviews the timeline, preview, and final deliverable.' },
    skills: { packs: [{ id: 'video-editing', dir: fileURLToPath(new URL('./skills', import.meta.url)), version: '1.0.0' }], uses: [{ ref: 'video-editing/video-editing', stages: ['plan'], member: 'editor', what: L('Evidence-based cuts, a shared frame clock and export QA', '基于真实素材剪辑、统一帧时钟和成片质检') }] },
    ops: opsOf,
    actions: {
      async decision(c) {
        if (savesFor(c.store).has(c.run.id) || locksFor(c.store).edits.has(c.run.id)) throw new Error('Wait for the timeline save to finish before deciding this review')
        const p = c.approval.payload, option = p.options?.[Number(p.choice)]
        if (option?.action === 'accept' && ['review', 'preview-review', 'final-review'].includes(p.stage)) {
          if (p.videoDigest !== editDigest(c.run)) throw new Error('Open the video review and inspect the current version before approving; the edit or source inventory changed')
          const media = p.stage === 'final-review' ? c.run.video?.export : p.stage === 'preview-review' ? c.run.video?.preview : null
          if (p.stage !== 'review' && (!media || media.timelineSha256 !== digest(timelineOf(c.run)) || media.sourceSha256 !== sourceDigest(c.run) || p.videoArtifactSha256 !== media.sha256)) throw new Error('The rendered video changed. Open the current video and review it before approving.')
        }
        return commonActions.decision(c)
      },
    },
    workflows: { edit: {
      title: 'Edit a video', description: 'Inspect local footage, edit a validated timeline, review a playable preview, and approve a verified H.264/AAC MP4 with subtitles and a reproducibility manifest.', noun: 'video', insertFrom: 'plan', reviseFrom: 'plan',
      preferenceOptions: ['detail', 'tone', 'pacing', 'captions'],
      feedbackConsumers: { intake: ['plan'], inspect: ['plan'], review: ['plan'], preview: ['plan'], 'preview-review': ['plan'], export: ['plan'], 'final-review': ['plan'], report: ['plan'] },
      input: [
        { name: 'sources', type: 'files', label: 'Video files (up to 25 MiB each; for larger footage use a local source folder)' },
        { name: 'sourceFolder', type: 'text', label: 'Local source folder (absolute path, read only)' },
        { name: 'sourcePaths', type: 'textarea', label: 'Large source videos: one relative path per line inside the source folder' },
        { name: 'aspect', type: 'select', label: 'Output shape', options: [{ value: 'landscape', label: '16:9 · landscape' }, { value: 'portrait', label: '9:16 · portrait' }, { value: 'square', label: '1:1 · square' }], default: 'landscape' },
        { name: 'targetSeconds', type: 'text', label: 'Initial assembly duration (seconds, up to 1800)', default: '60' },
        { name: 'assisted', type: 'checkbox', label: 'Ask the editing agent to plan the cuts', default: false },
      ],
      validateInput: subject => !(subject.attachments?.length || String(subject.fields?.sourcePaths || '').trim()) ? 'Add video footage or local source paths' : '',
      roles: { editor: { agent: 'sonnet', fallback: 'codex', access: 'write', text: 'Plans a source-grounded video edit as timeline.json and explains decisions; preserves verified speech, clip identities, and the person’s review notes.' } },
      stages: [intake, inspect, plan, review, preview, previewReview, exportStage, finalReview, report],
      report: renderReport,
    } },
  }
}
