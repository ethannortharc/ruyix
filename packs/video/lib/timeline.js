export const OUTPUTS = {
  landscape: { width: 1920, height: 1080 }, portrait: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 },
}
const object = (x, label) => { if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Error(`${label} must be an object`); return x }
const number = (x, lo, hi, label) => { if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) throw new Error(`${label} must be a number from ${lo} to ${hi}`); return x }
const id = (x, label) => { if (typeof x !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(x)) throw new Error(`${label} must be a stable identifier`); return x }
const words = (x, max = 1000) => String(x || '').replace(/\0/g, '').slice(0, max)
const keys = (x, allowed, label) => { for (const k of Object.keys(x)) if (!allowed.includes(k)) throw new Error(`${label}.${k} is not supported`) }

/** A small, versioned EDL. All timing is resolved to one output frame clock; no executable filters or paths. */
export function validateTimeline(raw, sources) {
  object(raw, 'timeline'); keys(raw, ['version', 'title', 'output', 'clips', 'captions'], 'timeline')
  if (raw.version !== 1) throw new Error('timeline.version must be 1')
  const o = object(raw.output, 'output')
  keys(o, ['width', 'height', 'fps', 'fit', 'crf', 'normalizeAudio'], 'output')
  const width = number(o.width, 128, 1920, 'width'), height = number(o.height, 128, 1920, 'height')
  if (width % 2 || height % 2 || width * height > 2073600) throw new Error('Output must use even dimensions up to 1920×1080 / 1080×1920')
  if (![24, 25, 30, 50, 60].includes(o.fps)) throw new Error('fps must be 24, 25, 30, 50 or 60')
  if (!['contain', 'cover'].includes(o.fit)) throw new Error('fit must be contain or cover')
  if (o.normalizeAudio !== undefined && typeof o.normalizeAudio !== 'boolean') throw new Error('normalizeAudio must be a boolean')
  const output = { width, height, fps: o.fps, fit: o.fit, crf: number(o.crf ?? 20, 16, 30, 'crf'), normalizeAudio: o.normalizeAudio ?? false }
  if (!Array.isArray(raw.clips) || !raw.clips.length || raw.clips.length > 100) throw new Error('Use between 1 and 100 clips')
  const sourceMap = new Map(sources.map(s => [s.id, s])), seen = new Set()
  let frame = 0
  const clips = raw.clips.map((c, i) => {
    object(c, `clip ${i + 1}`); keys(c, ['id', 'source', 'in', 'out', 'speed', 'volume', 'reason'], `clip ${i + 1}`)
    const cid = id(c.id, 'clip.id'), source = sourceMap.get(c.source)
    if (seen.has(cid)) throw new Error(`Duplicate clip id: ${cid}`)
    seen.add(cid)
    if (!source) throw new Error(`Unknown source: ${c.source}`)
    const start = number(c.in, 0, source.duration, `${cid}.in`), end = number(c.out, 0, source.duration + 0.001, `${cid}.out`)
    const speed = number(c.speed ?? 1, 0.5, 2, `${cid}.speed`), volume = number(c.volume ?? 1, 0, 2, `${cid}.volume`)
    if (end <= start) throw new Error(`${cid}: out must be later than in`)
    const frames = Math.floor((end - start) / speed * output.fps + 1e-6)
    if (frames < 2) throw new Error(`${cid}: use at least two output frames`)
    const clip = { id: cid, source: source.id, in: start, out: end, speed, volume, reason: words(c.reason) }
    frame += frames
    return clip
  })
  const duration = frame / output.fps
  if (duration > 1800) throw new Error('One export is limited to 30 minutes; split the project into episodes')
  if (!Array.isArray(raw.captions ?? [] ) || (raw.captions || []).length > 1000) throw new Error('captions must be an array of at most 1000 cues')
  let last = 0
  const captions = (raw.captions || []).map((c, i) => {
    object(c, `caption ${i + 1}`); keys(c, ['id', 'start', 'end', 'text'], `caption ${i + 1}`)
    const start = number(c.start, 0, duration, 'caption.start'), end = number(c.end, 0, duration, 'caption.end')
    if (end <= start || start < last) throw new Error('Caption cues must be ordered, non-overlapping and within the output duration')
    if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(c.text)) throw new Error('Caption text is required (up to 500 characters)')
    last = end
    return { id: id(c.id, 'caption.id'), start, end, text: c.text.trim() }
  })
  if (new Set(captions.map(c => c.id)).size !== captions.length) throw new Error('Duplicate caption ids')
  return { version: 1, title: words(raw.title, 200), output, clips, captions }
}
export function resolvedClips(timeline) {
  let frame = 0
  return timeline.clips.map(c => {
    const frames = Math.floor((c.out - c.in) / c.speed * timeline.output.fps + 1e-6)
    const result = { ...c, startFrame: frame, frames, duration: frames / timeline.output.fps }
    frame += frames
    return result
  })
}
export const durationOf = timeline => resolvedClips(timeline).reduce((n, c) => n + c.frames, 0) / timeline.output.fps
export function initialTimeline(sources, { title = '', aspect = 'landscape', duration = 60 } = {}) {
  let remaining = Math.max(1, Math.min(Number(duration) || 60, 1800))
  const clips = []
  for (const source of sources) {
    if (remaining < 2 / 30) break
    const end = Math.min(source.duration, remaining)
    if (end < 2 / 30) continue
    clips.push({ id: `clip-${clips.length + 1}`, source: source.id, in: 0, out: end, speed: 1, volume: 1, reason: 'Initial assembly — review the footage and adjust the cut points.' })
    remaining -= end
  }
  return validateTimeline({ version: 1, title, output: { ...(OUTPUTS[aspect] || OUTPUTS.landscape), fps: 30, fit: 'contain', crf: 20, normalizeAudio: false }, clips, captions: [] }, sources)
}
const time = (n, separator) => { const ms = Math.round(n * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${separator}${String(ms % 1000).padStart(3, '0')}` }
export const subtitles = (timeline, format = 'vtt') => `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${timeline.captions.map((c, i) => `${i + 1}\n${time(c.start, format === 'vtt' ? '.' : ',')} --> ${time(c.end, format === 'vtt' ? '.' : ',')}\n${c.text.replace(/-->/g, '→').replace(/[<>]/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n')}\n`).join('\n')}`
