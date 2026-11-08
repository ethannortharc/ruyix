import { useEffect, useRef, useState } from 'react'
import css from './styles.css'

const fileURL = (run, seq, download = false) => `api/ruyix-workbench/file?run=${encodeURIComponent(run)}&seq=${seq}${download ? '&download=1' : ''}`
const seconds = (clips, fps) => clips.reduce((sum, c) => sum + Math.floor((Number(c.out) - Number(c.in)) / Number(c.speed || 1) * fps + 1e-6), 0) / fps
const clone = x => JSON.parse(JSON.stringify(x))

export function TimelineEditor({ a, run, open, visible = true, lang, call, onBlocked, onPayload, onDirty }) {
  const zh = String(lang).startsWith('zh'), t = (en, cn) => zh ? cn : en
  const [data, setData] = useState(null), [draft, setDraft] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState(0), [advanced, setAdvanced] = useState(false), [json, setJson] = useState(''), [sourceError, setSourceError] = useState(false)
  const [loading, setLoading] = useState(false), [stale, setStale] = useState(false), [markError, setMarkError] = useState('')
  const player = useRef(null), current = useRef(null), request = useRef(0), owner = useRef(run.id)
  const dirty = !!data && (advanced ? json !== JSON.stringify(data.timeline, null, 2) : JSON.stringify(draft) !== JSON.stringify(data.timeline))
  const gate = a?.payload?.stage || run.stage
  const media = gate === 'final-review' ? data?.export : gate === 'preview-review' ? data?.preview : null
  current.current = { data, draft, json, advanced, dirty, busy }
  useEffect(() => { if (!visible) player.current?.pause() }, [visible])
  const load = async (discard = false) => {
    if (owner.current !== run.id) {
      owner.current = run.id
      current.current = { data: null, draft: null, json: '', advanced: false, dirty: false, busy: false }
      setData(null); setDraft(null); setJson(''); setAdvanced(false); setBusy(false); setStale(false); setError('')
    }
    const before = current.current
    if (before.busy) return
    if (discard === true && before.dirty && !window.confirm(t('Discard your unsaved timeline changes and reload the saved version?', '放弃未保存的时间线修改，重新载入已保存版本？'))) return
    const seq = ++request.current
    setLoading(true)
    try {
      const d = await call('timeline', { run: run.id })
      if (seq !== request.current || owner.current !== run.id) return
      const now = current.current
      // Refreshes keep both the local draft and its CAS base. A confirmed reload also preserves edits typed during the request.
      const unchanged = now.draft === before.draft && now.json === before.json && now.advanced === before.advanced
      if (now.dirty && !(discard === true && unchanged)) {
        const changed = d.digest !== now.data?.digest
        setStale(changed)
        if (!changed) setData(d)
        return
      }
      setData(d); setDraft(clone(d.timeline)); setJson(JSON.stringify(d.timeline, null, 2)); setSelected(i => Math.min(i, d.timeline.clips.length - 1)); setStale(false); setError('')
    } catch (e) { if (seq === request.current) setError(e.message) }
    finally { if (seq === request.current) setLoading(false) }
  }
  const editVersion = (run.edits || []).filter(e => e.path === 'timeline.json').map(e => `${e.version || ''}:${e.at || ''}`).join('|')
  // A generic Viewer save changes run.edits. Saves defer refresh until their own response has been applied.
  useEffect(() => { load() }, [run.id, run.stage, open, editVersion, busy])
  useEffect(() => () => { ++request.current }, [])
  useEffect(() => { setSourceError(false) }, [draft?.clips?.[selected]?.source, data?.preview?.seq, data?.export?.seq])
  useEffect(() => { setMarkError('') }, [draft?.clips?.[selected]?.id, draft?.clips?.[selected]?.source, draft?.clips?.[selected]?.speed, draft?.output.fps])
  useEffect(() => { if (data) onPayload?.({ videoDigest: data.digest, videoArtifactSha256: media?.sha256 || null }) }, [data?.digest, media?.sha256])
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  useEffect(() => { onBlocked?.(!!open && (!data || dirty || busy || loading || stale || !!error)); return () => onBlocked?.(false) }, [open, !!data, dirty, busy, loading, stale, error])
  if (!data || !draft || owner.current !== run.id) return <div role={error ? 'alert' : 'status'}>{error || t('Loading video timeline…', '正在加载剪辑时间线…')}{error && <button disabled={loading} onClick={() => load()}>{t('Retry', '重试')}</button>}</div>
  const editable = open && data.editable && gate === 'review', clip = draft.clips[selected], source = data.sources.find(s => s.id === clip?.source)
  const setClip = (key, value) => { setMarkError(''); setDraft(d => ({ ...d, clips: d.clips.map((c, i) => i === selected ? { ...c, [key]: value } : c) })) }
  const markPlayhead = key => {
    const gap = 2 * clip.speed / draft.output.fps
    const at = Math.min(source.duration, Math.max(0, player.current?.currentTime || 0))
    // Keep the requested mark exact; only the opposite endpoint may move to make room for two output frames.
    const start = key === 'in' ? at : Math.max(0, Math.min(clip.in, at - gap))
    const end = key === 'out' ? at : Math.min(source.duration, Math.max(clip.out, at + gap))
    if (Math.floor((end - start) / clip.speed * draft.output.fps + 1e-6) < 2) {
      setMarkError(key === 'in'
        ? t('Cannot set in here: choose a point with at least two output frames before the source ends. The clip is unchanged.', '无法在此设置入点：请选择距素材结束至少两个输出帧的位置。片段未改动。')
        : t('Cannot set out here: choose a point at least two output frames after the source begins. The clip is unchanged.', '无法在此设置出点：请选择距素材开始至少两个输出帧的位置。片段未改动。'))
      return
    }
    setMarkError('')
    setDraft(d => ({ ...d, clips: d.clips.map((c, i) => i === selected ? { ...c, in: start, out: end } : c) }))
  }
  const move = delta => { const n = selected + delta; if (n < 0 || n >= draft.clips.length) return; setDraft(d => { const clips = [...d.clips]; [clips[selected], clips[n]] = [clips[n], clips[selected]]; return { ...d, clips } }); setSelected(n) }
  const save = async () => {
    if (current.current.busy || stale) return
    const seq = ++request.current
    current.current = { ...current.current, busy: true }
    setLoading(false)
    setBusy(true); setError('')
    try {
      const timeline = advanced ? JSON.parse(json) : draft
      const d = await call('saveTimeline', { run: run.id, timeline, expectedDigest: data.digest })
      if (seq !== request.current || owner.current !== run.id) return
      setData(d); setDraft(clone(d.timeline)); setJson(JSON.stringify(d.timeline, null, 2)); setSelected(i => Math.min(i, d.timeline.clips.length - 1)); setStale(false)
    } catch (e) { if (seq === request.current) setError(e.message) }
    finally { if (seq === request.current) { current.current = { ...current.current, busy: false }; setBusy(false) } }
  }
  return <section className="vid-editor">
    <div className="vid-summary"><strong>{draft.title || t('Video edit', '视频剪辑')}</strong><span>{draft.clips.length} {t('clips', '段')} · {seconds(draft.clips, draft.output.fps).toFixed(2)}s · {draft.output.width}×{draft.output.height} · {draft.output.fps} fps</span></div>
    {(error || stale) && <div className="vid-error" role="alert">{stale ? t('The saved timeline changed in another editor. Your draft is preserved. Copy any changes you want to keep before reloading.', '其他编辑器已保存新版时间线。本地草稿已保留；重新载入前，请复制需要保留的修改。') : error} <button disabled={busy || loading} onClick={() => load(true)}>{t('Reload', '重新载入')}</button></div>}
    <div className="vid-layout">
      <div className="vid-viewer">
        {media ? <><video ref={player} key={media.seq} controls preload="metadata" src={fileURL(run.id, media.seq)}>{media.captionSeq && <track kind="subtitles" src={fileURL(run.id, media.captionSeq)} srcLang="und" label={t('Captions', '字幕')} default />}</video><p>{gate === 'final-review' ? t('Final export · full decode verified', '最终成片 · 已通过完整解码检查') : t('Rendered preview · full decode verified', '真实渲染预览 · 已通过完整解码检查')}</p><div className="vid-downloads"><a href={fileURL(run.id, media.seq, true)}>{t('Download MP4', '下载 MP4')}</a><a href={fileURL(run.id, media.manifestSeq, true)}>{t('Export manifest', '导出清单')}</a>{media.captionSeq && <a href={fileURL(run.id, media.captionSeq, true)}>{t('Captions (VTT)', '字幕 (VTT)')}</a>}</div></>
          : source ? <><video ref={player} key={source.id} controls preload="metadata" onError={() => setSourceError(true)} onLoadedMetadata={() => { if (player.current) player.current.currentTime = clip.in }} src={source.evidence ? fileURL(run.id, source.evidence) : `api/ruyix-video/source?run=${encodeURIComponent(run.id)}&source=${encodeURIComponent(source.id)}`} /><p>{t('Original source footage', '原始素材')}</p>{sourceError && <p role="status">{t('This browser cannot play the original codec. Keep or adjust the measured source ranges, then approve the timeline to make a compatible H.264 preview with FFmpeg. Original footage is unchanged.', '浏览器无法播放此素材编码。可以保留或调整已测量的素材范围，审核时间线后由 FFmpeg 生成兼容的 H.264 预览。原始素材不会改动。')}</p>}</>
            : <div className="vid-empty"><strong>{t('Your edit starts here', '从时间线开始剪辑')}</strong><p>{t('Choose source ranges below. Approve the timeline to render a playable preview.', '在下方选择素材片段。审核时间线后，会生成可播放的预览。')}</p></div>}
        <div className="vid-strip" aria-label={t('Timeline clips', '时间线片段')}>{draft.clips.map((c, i) => <button key={c.id} aria-pressed={i === selected} onClick={() => { setSelected(i); if (player.current) player.current.currentTime = media ? seconds(draft.clips.slice(0, i), draft.output.fps) : c.in }}><b>{String(i + 1).padStart(2, '0')}</b><span>{data.sources.find(s => s.id === c.source)?.name || c.source}</span><small>{c.in.toFixed(2)}–{c.out.toFixed(2)}s · {c.speed}×</small></button>)}</div>
      </div>
      <div className="vid-controls">
        <div className="vid-source-list"><h4>{t('Inspected sources', '已检查的素材')}</h4>{data.sources.map(s => <div key={s.id}><b>{s.name}</b><small>{s.duration.toFixed(2)}s · {s.width}×{s.height} · {s.audio ? t('audio', '有音轨') : t('silent', '无音轨')}</small>{editable && <button disabled={busy || advanced} onClick={() => { const n = draft.clips.length; setDraft(d => ({ ...d, clips: [...d.clips, { id: `clip-${crypto.randomUUID().slice(0, 8)}`, source: s.id, in: 0, out: Math.min(s.duration, 10), speed: 1, volume: 1, reason: '' }] })); setSelected(n) }}>{t('Add clip', '添加片段')}</button>}</div>)}</div>
        {clip && <fieldset disabled={!editable || busy || advanced}><legend>{t('Selected clip', '当前片段')} {selected + 1}</legend><label>{t('Source', '素材')}<select value={clip.source} onChange={e => { const s = data.sources.find(s => s.id === e.target.value); setDraft(d => ({ ...d, clips: d.clips.map((c, i) => i === selected ? { ...c, source: s.id, in: 0, out: Math.min(s.duration, c.out - c.in) } : c) })) }}>{data.sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <div className="vid-fields">{[['in', t('In (s)', '入点（秒）'), 0, source?.duration, 0.01], ['out', t('Out (s)', '出点（秒）'), 0, source?.duration, 0.01], ['speed', t('Speed', '速度'), 0.5, 2, 0.1], ['volume', t('Volume', '音量'), 0, 2, 0.1]].map(([key, label, min, max, step]) => <label key={key}>{label}<input type="number" value={clip[key]} min={min} max={max} step={step} onChange={e => setClip(key, Number(e.target.value))} /></label>)}</div>
          {!media && source && <div className="vid-actions"><button onClick={() => markPlayhead('in')}>{t('Set in at playhead', '播放头设为入点')}</button><button onClick={() => markPlayhead('out')}>{t('Set out at playhead', '播放头设为出点')}</button>{markError && <p role="alert">{markError}</p>}</div>}<label>{t('Cut rationale', '剪辑理由')}<textarea rows="2" value={clip.reason} onChange={e => setClip('reason', e.target.value)} /></label><div className="vid-actions"><button disabled={selected === 0} onClick={() => move(-1)}>{t('Move earlier', '前移')}</button><button disabled={selected === draft.clips.length - 1} onClick={() => move(1)}>{t('Move later', '后移')}</button><button disabled={draft.clips.length < 2} onClick={() => { setDraft(d => ({ ...d, clips: d.clips.filter((_, i) => i !== selected) })); setSelected(Math.max(0, selected - 1)) }}>{t('Remove', '删除')}</button></div>
        </fieldset>}
        <fieldset disabled={!editable || busy || advanced}><legend>{t('Output', '输出')}</legend><label>{t('Shape', '画幅')}<select value={`${draft.output.width}x${draft.output.height}`} onChange={e => { const [width, height] = e.target.value.split('x').map(Number); setDraft(d => ({ ...d, output: { ...d.output, width, height } })) }}><option value="1920x1080">16:9 · 1920×1080</option><option value="1080x1920">9:16 · 1080×1920</option><option value="1080x1080">1:1 · 1080×1080</option>{!['1920x1080', '1080x1920', '1080x1080'].includes(`${draft.output.width}x${draft.output.height}`) && <option value={`${draft.output.width}x${draft.output.height}`}>{draft.output.width}×{draft.output.height}</option>}</select></label><label>{t('Fit', '适配')}<select value={draft.output.fit} onChange={e => setDraft(d => ({ ...d, output: { ...d.output, fit: e.target.value } }))}><option value="contain">{t('Contain · preserve the full image', '完整画面（留黑边）')}</option><option value="cover">{t('Cover · crop to fill', '裁切填满')}</option></select></label><label>{t('Frame rate', '帧率')}<select value={draft.output.fps} onChange={e => setDraft(d => ({ ...d, output: { ...d.output, fps: Number(e.target.value) } }))}>{[24, 25, 30, 50, 60].map(f => <option key={f}>{f}</option>)}</select></label><label><input type="checkbox" checked={draft.output.normalizeAudio} onChange={e => setDraft(d => ({ ...d, output: { ...d.output, normalizeAudio: e.target.checked } }))} /> {t('Normalize audio to −16 LUFS', '响度处理：−16 LUFS')}</label></fieldset>
      </div>
    </div>
    {editable && <><button disabled={busy} onClick={() => { if (!advanced) setJson(JSON.stringify(draft, null, 2)); else if (dirty) { setError(t('Validate and save JSON changes before closing the editor.', '请先校验并保存 JSON 修改，再关闭编辑器。')); return } setAdvanced(!advanced) }}>{advanced ? t('Close JSON editor', '关闭 JSON 编辑器') : t('Edit captions / timeline JSON', '编辑字幕 / 时间线 JSON')}</button>{advanced && <textarea disabled={busy} className="vid-json" rows="18" aria-label={t('Timeline JSON', '时间线 JSON')} value={json} onChange={e => setJson(e.target.value)} spellCheck="false" />}<div className="vid-actions"><button disabled={!dirty || busy || stale} onClick={save}>{busy ? t('Saving…', '保存中…') : t('Validate & save timeline', '校验并保存时间线')}</button>{dirty && <small>{t('Save changes before approving this review.', '先保存修改，再批准本轮审核。')}</small>}</div></>}
    {!editable && <p className="vid-hint">{t('To change the edit, use “Ask for changes” and return to the plan/timeline review.', '修改剪辑请使用「退回修改」，返回剪辑方案 / 时间线审核。')}</p>}
  </section>
}
export const inject = []
export function apply(ctx) {
  window.__ruyixWorkbenchExt ??= {}
  window.__ruyixWorkbenchExt.video = { decisionEditors: { timeline: TimelineEditor }, css }
  window.dispatchEvent(new Event('ruyix-workbench-ext'))
  ctx?.effect?.(() => () => { delete window.__ruyixWorkbenchExt?.video; window.dispatchEvent(new Event('ruyix-workbench-ext')) })
}
