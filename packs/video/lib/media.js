import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, stat } from 'node:fs/promises'
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, relative } from 'node:path'
import { digest, folderOf, hashFile, inside, writeJson } from './files.js'
import { durationOf, resolvedClips, subtitles, validateTimeline } from './timeline.js'

const FORMATS = 'mov,matroska,webm,avi,mpeg,mpegts,ogg'
const EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpeg|mpg|ts|ogv)$/i
const MAX_FILE = 10 * 1024 ** 3
const error = (message, code) => Object.assign(new Error(message), { code })
const ratio = value => { const [n, d = 1] = String(value).split('/').map(Number); return n / d }
const timestamp = value => {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value || '')
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : NaN
}

/** No shell, bounded diagnostic buffers, a deadline, cancellation, and a hard-kill fallback. */
export function command(binary, args, { signal, timeout = 60000, cwd } = {}) {
  if (signal?.aborted) return Promise.reject(error('Video operation cancelled', 'cancelled'))
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = '', terminal, hardKill
    const stop = why => {
      terminal ||= why
      child.kill('SIGTERM')
      hardKill ||= setTimeout(() => child.kill('SIGKILL'), 1500)
    }
    const abort = () => stop(error('Video operation cancelled', 'cancelled'))
    const timer = setTimeout(() => stop(error(`Video operation exceeded ${Math.round(timeout / 1000)} seconds`, 'timeout')), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    child.stdout.on('data', b => { const next = out + b.toString(); out = next.slice(0, 2 * 1024 * 1024); if (next.length > out.length) stop(error('Media tool returned too much data', 'outputLimit')) })
    child.stderr.on('data', b => { err = (err + b.toString()).slice(-65536) })
    child.once('error', e => { terminal = e.code === 'ENOENT' ? error(`${binary} is not installed. Install FFmpeg (including ffprobe), or set Video pack ffmpeg/ffprobe executable paths.`, 'missingDependency') : e })
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(hardKill); signal?.removeEventListener('abort', abort)
      if (terminal) reject(terminal)
      else if (code !== 0) reject(error(`${binary} failed (${code}): ${err.trim().slice(-3500)}`, 'mediaFailed'))
      else resolve({ stdout: out, stderr: err })
    })
  })
}
export async function dependencies(settings = {}, signal) {
  const versions = {}
  for (const name of ['ffmpeg', 'ffprobe']) versions[name] = (await command(settings[name] || name, ['-version'], { signal, timeout: 10000 })).stdout.split('\n')[0]
  const encoders = (await command(settings.ffmpeg || 'ffmpeg', ['-hide_banner', '-encoders'], { signal, timeout: 10000 })).stdout
  if (!/\blibx264\b/.test(encoders) || !/\baac\b/.test(encoders)) throw error('This FFmpeg build needs libx264 and AAC encoders for browser-playable MP4 export.', 'missingEncoder')
  return versions
}
export async function probe(path, { settings = {}, signal } = {}) {
  const { stdout } = await command(settings.ffprobe || 'ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', FORMATS, '-show_format', '-show_streams', '-of', 'json', path], { signal, timeout: 30000 })
  const result = JSON.parse(stdout), video = result.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  if (!video || !Number.isFinite(Number(video.width)) || !Number.isFinite(Number(video.height))) throw new Error('Source contains no video stream')
  // Source times are relative to the container's playback origin, as are input -ss and the browser player.
  // A longer audio track must not extend the editable video range. Matroska's DURATION tag is an end timestamp.
  const formatStart = Number(result.format?.start_time), streamStart = Number(video.start_time)
  const origin = Number.isFinite(formatStart) ? formatStart : 0, videoStart = Number.isFinite(streamStart) ? streamStart : origin
  const streamDuration = Number(video.duration) || Number(video.duration_ts) * ratio(video.time_base)
  const videoEnd = streamDuration > 0 ? videoStart + streamDuration : timestamp(video.tags?.DURATION)
  const duration = videoEnd - origin, containerDuration = Number(result.format?.duration)
  if (!(duration > 0 && duration <= 86400)) throw new Error('Source must have a known video-stream duration between 0 and 24 hours; remux media without video duration metadata before importing')
  if (video.width > 8192 || video.height > 8192 || video.width < 2 || video.height < 2) throw new Error('Source dimensions must be within 2–8192 pixels')
  const audio = result.streams.find(s => s.codec_type === 'audio')
  return { duration, containerDuration: containerDuration > 0 ? containerDuration : null, width: video.width, height: video.height, fps: ratio(video.avg_frame_rate) > 0 ? video.avg_frame_rate : video.r_frame_rate, videoCodec: video.codec_name, videoStream: video.index, audio: !!audio, audioStream: audio?.index ?? null, audioCodec: audio?.codec_name || null, rotation: Number(video.side_data_list?.find(s => s.rotation !== undefined)?.rotation || video.tags?.rotate || 0) }
}

/** Sources are resolved from user-selected attachments or a read-only source folder, never from an agent's EDL. */
export async function ingest(run, options = {}) {
  const candidates = []
  for (const a of run.subject?.attachments || []) {
    if (a.field && a.field !== 'sources') continue
    if (!EXT.test(a.name)) continue
    candidates.push({ name: a.name, root: run.dir, path: relative(run.dir, a.path).split('\\').join('/'), evidence: a.evidence })
  }
  const fields = run.subject?.fields || {}, paths = String(fields.sourcePaths || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  if (paths.length) {
    if (!fields.sourceFolder || !isAbsolute(fields.sourceFolder)) throw new Error('For large local files, provide an absolute source folder and one relative video path per line')
    for (const path of paths) candidates.push({ name: path, root: fields.sourceFolder, path })
  }
  if (!candidates.length) throw new Error('Add a video attachment or select a local source folder with relative source paths')
  if (candidates.length > 20) throw new Error('Use at most 20 source videos per project')
  const sources = []
  for (const [i, candidate] of candidates.entries()) {
    if (!EXT.test(candidate.path)) throw new Error(`Unsupported source extension: ${candidate.name}`)
    const path = inside(candidate.root, candidate.path, { file: true }), before = await stat(path), size = before.size
    if (size > MAX_FILE) throw new Error(`${candidate.name} is larger than the 10 GiB local source limit`)
    const info = await probe(path, options), sha256 = await hashFile(path, options.signal)
    const after = await stat(path)
    if (after.size !== size || after.mtimeMs !== before.mtimeMs) throw new Error(`${candidate.name} changed while importing; try again after the file finishes copying`)
    sources.push({ ...candidate, id: `source-${i + 1}`, ...info, size, mtimeMs: after.mtimeMs, sha256 })
  }
  return sources
}
export function sourcePath(source) { return inside(source.root, source.path, { file: true }) }
export function sourceForPlayback(run, id) {
  if (!run || run.template !== 'video.edit') throw new Error('No video editing run')
  const source = run.video?.sources?.find(s => s.id === id)
  if (!source) throw new Error('This source is not part of the run')
  const path = sourcePath(source), info = statSync(path)
  if (info.size !== source.size || info.mtimeMs !== source.mtimeMs) throw new Error('The source changed after import; re-import before reviewing it')
  return { path, name: source.name }
}
export async function verifySources(sources, signal) {
  for (const source of sources) {
    const path = sourcePath(source)
    if ((await stat(path)).size !== source.size || await hashFile(path, signal) !== source.sha256) throw error(`${source.name} changed since import. Re-run the import step and review the new edit before exporting.`, 'sourceChanged')
  }
}
const input = path => ['-protocol_whitelist', 'file', '-format_whitelist', FORMATS, '-i', path]
const dimensions = (o, preview) => {
  if (!preview) return { width: o.width, height: o.height }
  const scale = Math.min(1, 640 / Math.max(o.width, o.height))
  return { width: Math.max(2, Math.round(o.width * scale / 2) * 2), height: Math.max(2, Math.round(o.height * scale / 2) * 2) }
}
export function clipArgs(clip, source, timeline, size, output) {
  const { width: w, height: h } = size, fps = timeline.output.fps
  const sourceFps = ratio(source.fps), tailFrames = Math.min(clip.frames, Math.ceil(fps / (sourceFps > 0 ? sourceFps : fps) / clip.speed) + 1)
  const fit = timeline.output.fit === 'cover' ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}` : `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-threads', '2', '-ss', String(clip.in), ...input(sourcePath(source))]
  if (!source.audio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')
  // Input seeking already subtracts the requested in-point. Preserve the fractional first-frame PTS,
  // otherwise video advances relative to audio and loses up to two output frames at a slowed EOF cut.
  // Duplicate only a bounded frame interval at EOF; the approved duration and exact frame limit still win.
  args.push('-map', `0:${source.videoStream}`, '-map', source.audio ? `0:${source.audioStream}` : '1:a:0', '-vf', `setpts=PTS/${clip.speed},${fit},setsar=1,fps=${fps}:start_time=0,tpad=stop_mode=clone:stop=${tailFrames},format=yuv420p`,
    '-af', `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=48000:first_pts=0,asetpts=PTS-STARTPTS,${clip.speed === 1 ? '' : `atempo=${clip.speed},`}volume=${clip.volume},apad`, '-t', String(clip.duration), '-frames:v', String(clip.frames),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(timeline.output.crf), '-threads', '2', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', output)
  return args
}

/** Normalize one clip at a time, concatenate deterministic segments, then validate the actual encoded deliverable. */
export async function render(run, raw, sources, { preview = false, settings = {}, signal } = {}) {
  const timeline = validateTimeline(raw, sources), versions = await dependencies(settings, signal)
  await verifySources(sources, signal)
  const top = folderOf(run), token = randomUUID(), scratchName = `video-render-${token}`, scratch = inside(top, scratchName)
  mkdirSync(scratch, { recursive: false })
  const size = dimensions(timeline.output, preview), clips = resolvedClips(timeline), executable = settings.ffmpeg || 'ffmpeg'
  const commands = [], startedAt = Date.now(), deadline = startedAt + 30 * 60000
  const exec = async args => {
    if (Date.now() >= deadline) throw error('Render exceeded the 30 minute job budget', 'timeout')
    commands.push(args)
    return command(executable, args, { signal, cwd: scratch, timeout: Math.min(10 * 60000, deadline - Date.now()) })
  }
  try {
    const current = { ...timeline, output: { ...timeline.output, crf: preview ? 28 : timeline.output.crf } }
    for (const [i, clip] of clips.entries()) {
      const source = sources.find(s => s.id === clip.source)
      await exec(clipArgs(clip, source, current, size, join(scratch, `clip-${i}.mkv`)))
    }
    // Explicit durations keep every join on the output frame clock rather than accumulating container rounding.
    writeFileSync(join(scratch, 'concat.txt'), clips.map((clip, i) => `file 'clip-${i}.mkv'\nduration ${clip.duration.toFixed(9)}`).join('\n'))
    const output = join(scratch, 'render.mp4'), captions = timeline.captions.length > 0
    if (captions) writeFileSync(join(scratch, 'captions.srt'), subtitles(timeline, 'srt'))
    const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', join(scratch, 'concat.txt')]
    if (captions) args.push('-protocol_whitelist', 'file', '-f', 'srt', '-i', join(scratch, 'captions.srt'))
    args.push('-map', '0:v:0', '-map', '0:a:0')
    if (captions) args.push('-map', '1:s:0', '-c:s', 'mov_text')
    args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2')
    if (timeline.output.normalizeAudio) args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000')
    args.push('-t', String(durationOf(timeline)), '-map_metadata', '-1', '-movflags', '+faststart', output)
    await exec(args)
    const info = await probe(output, { settings, signal }), expected = durationOf(timeline)
    if ([info.duration, info.containerDuration].some(duration => !Number.isFinite(duration) || Math.abs(duration - expected) > Math.max(0.15, 2 / timeline.output.fps)) || info.width !== size.width || info.height !== size.height || info.videoCodec !== 'h264' || info.audioCodec !== 'aac') throw new Error('Export failed QA: unexpected duration, dimensions, or codecs')
    // Decode the complete file. A successful encode alone is not proof of a playable artifact.
    const decoded = await exec(['-hide_banner', '-v', 'error', '-xerror', '-nostdin', ...input(output), '-map', '0:v:0', '-map', '0:a:0', '-fps_mode', 'passthrough', '-progress', 'pipe:1', '-f', 'null', '-'])
    const decodedFrames = Number([...decoded.stdout.matchAll(/^frame=(\d+)\s*$/gm)].at(-1)?.[1]), expectedFrames = clips.reduce((sum, clip) => sum + clip.frames, 0)
    if (decodedFrames !== expectedFrames) throw new Error(`Export failed QA: expected ${expectedFrames} video frames, decoded ${decodedFrames}`)
    await verifySources(sources, signal)
    const sha256 = await hashFile(output, signal), bytes = (await stat(output)).size
    const name = `exports/${preview ? 'preview' : 'video'}-${digest(timeline).slice(0, 12)}-${token.slice(0, 8)}.mp4`
    const target = inside(top, name)
    mkdirSync(inside(top, 'exports'), { recursive: true })
    renameSync(output, target)
    const manifest = { version: 1, kind: preview ? 'preview' : 'export', timeline, timelineSha256: digest(timeline), sources: sources.map(({ id, name, sha256, size, duration, containerDuration, width, height, audio, fps, videoStream, audioStream }) => ({ id, name, sha256, size, duration, containerDuration, width, height, audio, fps, videoStream, audioStream })),
      toolchain: versions, file: name, sha256, bytes, info, qa: { fullDecode: true, decodedFrames, expectedFrames, expectedDuration: expected, durationError: info.duration - expected }, commands: commands.map(args => args.map(a => a.replaceAll(scratch, '<render-directory>'))), createdAt: new Date().toISOString() }
    writeJson(run, `${name}.manifest.json`, manifest)
    return { name, path: target, sha256, bytes, timelineSha256: manifest.timelineSha256, info, manifest, manifestName: `${name}.manifest.json` }
  } finally { rmSync(inside(top, scratchName), { recursive: true, force: true }) }
}

/** Copy large output to the existing immutable ledger without allocating the movie as a Buffer. */
export async function recordFile(w, name, path, signal) {
  const stored = w.store.artifact(w.run.id, `video-${randomUUID()}${extname(name)}`, '')
  const target = w.store.artifactPath(w.run.id, stored.artifact)
  if (!target) throw new Error('Evidence store returned an unsafe artifact path')
  await copyFile(path, target)
  const sha256 = await hashFile(target, signal), bytes = (await stat(target)).size
  return w.evidence({ kind: 'file', title: name, input: { name, path: name, bytes, mime: name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.vtt') ? 'text/vtt' : 'application/json' }, output: `${bytes} bytes; SHA-256 ${sha256}`, ok: true, artifact: stored.artifact, sha256 })
}
