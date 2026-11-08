import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, inject } from './index.js'
import { pluginContext } from './test-context.mjs'
import { beforeFileMutation, createPack, opsOf } from './pack.js'
import { studio } from './studio.js'
import { definePack } from '../../core/workbench/pack.js'
import { defineStudio } from '../../core/plugins/studio/lib/declare.js'
import { checkInput } from '../../core/workbench/lib/subject.js'
import { digest, hashFile, inside, readJson, writeJson } from './lib/files.js'
import { command, dependencies, ingest, probe, render, sourceForPlayback, verifySources } from './lib/media.js'
import { durationOf, initialTimeline, subtitles, validateTimeline } from './lib/timeline.js'

const sources = [{ id: 'source-1', duration: 10 }, { id: 'source-2', duration: 7 }]
const base = () => initialTimeline(sources, { duration: 12 })
test('plugin bootstrap declares every service it reads, including connection in nested scopes', () => {
  const packs = [], routes = [], studios = []
  const services = {
    connection: { fetch: { register: route => routes.push(route) } },
    ruyixWorkbench: { registerPack: pack => { packs.push(pack); return () => {} } },
    ruyixStudio: { register: studio => { studios.push(studio); return () => {} } },
  }
  // A provided sibling service is not implicitly available through another dependency.
  assert.throws(() => pluginContext(services, ['ruyixWorkbench']).inject(['ruyixWorkbench'], ctx => ctx.connection), /connection.*without inject/)
  apply(pluginContext(services, inject))
  assert.deepEqual(packs.map(p => p.id), ['video'])
  assert.deepEqual(routes.map(r => [r.path, r.methods]), [['/api/ruyix-video/source', ['GET']]])
  assert.deepEqual(studios.map(s => s.id), ['video'])
  // Studio registration is optional; absence of that service must not hide the workflow or route.
  apply(pluginContext({ ...services, ruyixStudio: undefined }, inject))
  assert.equal(packs.length, 2); assert.equal(routes.length, 2); assert.equal(studios.length, 1)
})
test('pack, workflow and studio declarations agree', () => {
  const pack = definePack(createPack()), declared = defineStudio(studio)
  assert.equal(pack.id, declared.id)
  assert.deepEqual(checkInput(pack.workflows.edit.input), [])
  assert.equal(declared.start[0].workflow, 'video.edit')
  assert.equal(pack.workflows.edit.stages.filter(s => s.person).length, 3)
  assert.equal(pack.workflows.edit.stages.at(-1).key, 'report')
})
test('EDL validates source bounds, unsupported filters, dimensions, ids and captions', () => {
  assert.equal(durationOf(base()), 12)
  for (const change of [t => t.clips[0].out = 11, t => t.clips[0].in = -1, t => t.clips[0].speed = 0, t => t.clips[0].source = '../../private', t => t.clips[0].filter = 'movie=/private/file', t => t.output.width = 1079, t => t.output.width = 3000, t => t.clips[1].id = t.clips[0].id, t => t.clips[0].out = NaN]) {
    const t = base(); change(t); assert.throws(() => validateTimeline(t, sources))
  }
  const t = base(); t.captions = [{ id: 'caption-1', start: 0, end: 1, text: '你好 <script> --> world\n\nSecond line' }]
  assert.match(subtitles(validateTimeline(t, sources)), /^WEBVTT/)
  assert.doesNotMatch(subtitles(t), /<script>/)
  assert.match(subtitles(t), /world\nSecond line/)
  t.captions.push({ id: 'caption-2', start: 0.5, end: 2, text: 'overlap' })
  assert.throws(() => validateTimeline(t, sources), /non-overlapping/)
})
test('safe files reject traversal, absolute paths, metadata and symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-paths-')), other = mkdtempSync(join(tmpdir(), 'video-other-'))
  try {
    writeFileSync(join(other, 'source.mp4'), 'not video'); symlinkSync(other, join(dir, 'linked'))
    symlinkSync(join(other, 'source.mp4'), join(dir, 'leaf.mp4'))
    for (const path of ['../source.mp4', '/etc/passwd', '.git/config', 'linked/source.mp4', 'leaf.mp4', 'foo\\bar', 'foo/../bar']) assert.throws(() => inside(dir, path))
    writeJson({ dir }, 'timeline.json', base()); assert.equal(readJson({ dir }, 'timeline.json').version, 1)
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }) }
})
test('media subprocess has clear missing-dependency, timeout and cancellation behavior', async () => {
  await assert.rejects(command('/nonexistent/ruyix-ffmpeg', []), /Install FFmpeg/)
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 50 }), /exceeded/)
  const controller = new AbortController(), started = Date.now()
  const pending = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal })
  setTimeout(() => controller.abort(), 40)
  await assert.rejects(pending, /cancelled/)
  assert.ok(Date.now() - started < 3000)
})
test('timeline edits require an active review and optimistic concurrency digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-edit-'))
  let r = { id: 'test', template: 'video.edit', dir, status: 'waiting', video: { sources }, stages: [{ key: 'review', status: 'running' }] }
  let approvals = [{ runId: r.id, status: 'pending', payload: { stage: 'review' } }]
  writeJson(r, 'timeline.json', base())
  const ops = opsOf({ engine: { get: () => r, versions: { show: async () => ({ blob: 'timeline-blob' }) }, async editFile(id, { content, blob, by }) { assert.equal(blob, 'timeline-blob'); assert.equal(by, 'video'); writeFileSync(join(dir, 'timeline.json'), content) } }, store: { list: () => approvals, put: (kind, next) => r = next }, failWith: (code, params, text) => new Error(text) })
  try {
    await assert.rejects(ops.saveTimeline({ run: 'test', timeline: base(), expectedDigest: 'stale' }), /another view/)
    const t = base(); t.clips[0].in = 1
    const saved = await ops.saveTimeline({ run: 'test', timeline: t, expectedDigest: ops.timeline({ run: 'test' }).digest })
    assert.equal(saved.timeline.clips[0].in, 1)
    assert.equal(r.video.approvedPreview, null)
    approvals = []
    await assert.rejects(ops.saveTimeline({ run: 'test', timeline: t, expectedDigest: saved.digest }), /review step/)
    const exporting = createPack().workflows.edit.stages.find(s => s.key === 'export')
    const result = await exporting.run({ run: r })
    assert.equal(result.goto, 'preview')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('review acceptance binds the seen edit and media, and cannot race a timeline save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-approval-'))
  let r = { id: 'approval-test', template: 'video.edit', dir, status: 'waiting', video: { sources }, stages: [{ key: 'review', status: 'running' }] }
  const card = { id: 'approval-card', runId: r.id, status: 'pending', payload: { stage: 'review', choice: 0, options: [{ action: 'accept', label: 'Approve' }] } }
  let release
  const gate = new Promise(resolve => release = resolve)
  const store = { list: () => [card], put: (kind, next) => r = next }
  const ops = opsOf({ engine: { get: () => r, versions: { show: async () => ({ blob: 'timeline-blob' }) }, async editFile(id, { content }) { await gate; writeFileSync(join(dir, 'timeline.json'), content) } }, store, failWith: (code, params, text) => new Error(text) })
  const act = createPack().actions.decision
  const context = payload => ({ run: r, store, approval: { ...card, payload: { ...card.payload, ...payload } }, evidence() {}, update() {} })
  try {
    writeJson(r, 'timeline.json', base())
    const before = ops.timeline({ run: r.id }).digest
    await assert.rejects(act(context({})), /Open the video review/)
    assert.equal((await act(context({ videoDigest: before }))).option.action, 'accept')
    const next = base(); next.clips[0].in = 1
    const pending = ops.saveTimeline({ run: r.id, timeline: next, expectedDigest: before })
    await assert.rejects(act(context({ videoDigest: before })), /save to finish/)
    release(); await pending
    await assert.rejects(act(context({ videoDigest: before })), /current version/)
    const current = ops.timeline({ run: r.id }).digest
    await assert.rejects(act(context({ stage: 'preview-review', videoDigest: current, videoArtifactSha256: 'invented' })), /rendered video changed/)
  } finally { release(); rmSync(dir, { recursive: true, force: true }) }
})
test('plan preserves invalid existing edits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-invalid-plan-'))
  const pack = createPack(), plan = pack.workflows.edit.stages.find(s => s.key === 'plan')
  const run = { dir, video: { sources }, subject: { fields: {} } }
  try {
    const invalid = base(); invalid.clips[0].out = 11
    for (const content of ['{ incomplete JSON', JSON.stringify(invalid)]) {
      writeFileSync(join(dir, 'timeline.json'), content)
      await assert.rejects(plan.run({ run }))
      assert.equal(readFileSync(join(dir, 'timeline.json'), 'utf8'), content, 'validation must not replace the person’s work')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('file mutation leases serialize timeline editing and protect rendered outputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-file-guard-')), store = {}, run = { id: 'guard', dir }
  const guard = args => beforeFileMutation({ run, store, ...args })
  try {
    mkdirSync(join(dir, 'exports')); symlinkSync(join(dir, 'exports'), join(dir, 'alias'))
    for (const path of ['exports/movie.mp4.vtt', './exports/../exports/movie.manifest.json', 'exports\\movie.mp4', 'alias/movie.mp4.vtt']) assert.throws(() => guard({ kind: 'edit', path }), /read-only/)
    assert.equal(guard({ kind: 'restart' }), undefined, 'completed videos can be edited again')
    assert.equal(guard({ kind: 'rewind' }), undefined)
    const release = guard({ kind: 'edit', path: 'timeline.json' })
    for (const kind of ['restart', 'rewind']) assert.throws(() => guard({ kind }), { code: 'changedMeanwhile' })
    assert.throws(() => guard({ kind: 'edit', path: './timeline.json' }), { code: 'changedMeanwhile' })
    release()
    const again = guard({ kind: 'edit', path: 'timeline.json' }); again()
    assert.equal(guard({ kind: 'restart' }), undefined, 'release restores normal restarting')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('failed preview rerenders invalidate older preview, final output and approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'video-resume-'))
  let run = { dir, video: { sources, preview: { sha256: 'old-preview' }, export: { sha256: 'old-final' }, approvedPreview: 'old-preview' } }
  try {
    writeJson(run, 'timeline.json', base())
    const stage = createPack().workflows.edit.stages.find(s => s.key === 'preview')
    await assert.rejects(stage.run({ get run() { return run }, packSettings: { ffmpeg: '/nonexistent/video-ffmpeg' }, update: fn => run = fn(run) }), /Install FFmpeg/)
    assert.equal(run.video.preview, null); assert.equal(run.video.export, null); assert.equal(run.video.approvedPreview, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('native FFmpeg renders real cuts, mixed-aspect/silent media, captions, preview and manifest', { timeout: 120000 }, async t => {
  try { await dependencies() } catch (e) { if (e.code === 'missingDependency') return t.skip(e.message); throw e }
  const dir = mkdtempSync(join(tmpdir(), 'video-render-test-')), run = { id: 'video-test', dir, subject: { fields: { sourceFolder: dir, sourcePaths: 'red.mp4\nblue.mp4' } } }
  try {
    await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=30:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'red.mp4')])
    await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=90x160:r=24:d=1.6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'blue.mp4')])
    const media = await ingest(run)
    assert.equal(media[0].audio, true); assert.equal(media[1].audio, false)
    const playbackRun = { ...run, template: 'video.edit', video: { sources: media } }
    assert.ok(sourceForPlayback(playbackRun, 'source-1').path.endsWith('red.mp4'))
    assert.throws(() => sourceForPlayback(playbackRun, '../private'), /not part of the run/)
    const timeline = validateTimeline({ version: 1, title: 'Two verified cuts', output: { width: 320, height: 180, fps: 30, fit: 'contain', crf: 20, normalizeAudio: false }, clips: [
      { id: 'red', source: 'source-1', in: 0.2, out: 1.2, speed: 1, volume: 1 }, { id: 'blue', source: 'source-2', in: 0.1, out: 1.4, speed: 1.25, volume: 0.5 },
    ], captions: [{ id: 'label', start: 0, end: 0.8, text: 'First scene' }] }, media)
    const result = await render(run, timeline, media)
    assert.equal(result.info.videoCodec, 'h264'); assert.equal(result.info.audioCodec, 'aac'); assert.equal(result.manifest.qa.fullDecode, true)
    assert.equal(result.manifest.qa.decodedFrames, 61)
    assert.equal(result.sha256, await hashFile(result.path)); assert.ok(result.bytes > 5000)
    assert.equal(readJson(run, result.manifestName).timelineSha256, digest(timeline))
    const streams = JSON.parse((await command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.path])).stdout).streams
    assert.ok(streams.some(s => s.codec_name === 'mov_text'))
    for (const [time, name, index] of [[0.8, 'red-frame.rgb', 0], [1.3, 'blue-frame.rgb', 2]]) {
      const path = join(dir, name)
      await command('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', result.path, '-vf', 'crop=2:2:159:89', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', path])
      const pixels = readFileSync(path); assert.ok(pixels[index] > 180, `${name} has correct color after the edit cut`)
    }
    const pcm = join(dir, 'audio.raw')
    await command('ffmpeg', ['-v', 'error', '-i', result.path, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', pcm])
    const audio = readFileSync(pcm), rms = (start, end) => { let sum = 0, n = 0; for (let i = Math.floor(start * 48000) * 2; i < Math.min(audio.length, end * 48000 * 2); i += 2) { sum += audio.readInt16LE(i) ** 2; n++ } return Math.sqrt(sum / n) }
    assert.ok(rms(0.2, 0.7) > 500, 'original audio is audible before the cut')
    assert.ok(rms(1.3, 1.7) < 20, `a silent source remains silent after the cut (RMS ${rms(1.3, 1.7)}, audio seconds ${audio.length / 96000})`)
    const preview = await render(run, { ...timeline, output: { ...timeline.output, width: 1920, height: 1080 } }, media, { preview: true })
    assert.equal(preview.info.width, 640); assert.equal(preview.info.height, 360)
    writeFileSync(join(dir, 'blue.mp4'), 'changed')
    assert.throws(() => sourceForPlayback(playbackRun, 'source-2'), /changed after import/)
    await assert.rejects(verifySources(media), /changed since import/)
    assert.equal((await probe(result.path)).videoCodec, 'h264', 'an older verified export survives later source changes')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('native fractional-rate EOF cuts retain exact frames, audio duration and source timing', { timeout: 120000 }, async t => {
  try { await dependencies() } catch (e) { if (e.code === 'missingDependency') return t.skip(e.message); throw e }
  const dir = mkdtempSync(join(tmpdir(), 'video-fractional-test-')), run = { id: 'fractional-test', dir, subject: { fields: { sourceFolder: dir, sourcePaths: 'ntsc.mp4\nfilm.mp4' } } }
  const ffmpeg = args => command('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args])
  try {
    // A simultaneous flash and tone make temporal alignment observable, not just container metadata.
    for (const [name, rate] of [['ntsc', '30000/1001'], ['film', '24000/1001']]) await ffmpeg([
      '-f', 'lavfi', '-i', `color=black:s=160x128:r=${rate}:d=4.004`,
      '-f', 'lavfi', '-i', 'aevalsrc=if(between(t\\,1.001\\,1.201)\\,0.5*sin(2*PI*880*t)\\,0):s=48000:d=4.004',
      '-vf', "drawbox=color=white:t=fill:enable='between(t,1.001,1.201)'", '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, `${name}.mp4`),
    ])
    const media = await ingest(run)
    for (const source of media) for (const [speed, frames] of [[1, 116], [0.5, 232]]) {
      const timeline = validateTimeline({ version: 1, output: { width: 160, height: 128, fps: 30, fit: 'contain', crf: 20 }, clips: [{ id: 'tail', source: source.id, in: 0.137, out: 4.004, speed, volume: 1 }], captions: [] }, media)
      const result = await render(run, timeline, media)
      assert.equal(result.manifest.qa.decodedFrames, frames, `${source.fps} at ${speed}× must not lose the last one or two frames`)
      assert.ok(Math.abs(result.info.duration - frames / 30) < 0.001)
      const streams = JSON.parse((await command('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', result.path])).stdout).streams
      assert.ok(Math.abs(Number(streams.find(s => s.codec_type === 'audio').duration) - frames / 30) < 0.001, 'audio must reach the same approved endpoint')
      await ffmpeg(['-i', result.path, '-an', '-vf', 'scale=1:1', '-pix_fmt', 'gray', '-f', 'rawvideo', join(dir, 'frames.raw')])
      await ffmpeg(['-i', result.path, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', join(dir, 'audio.raw')])
      const video = readFileSync(join(dir, 'frames.raw')), audio = readFileSync(join(dir, 'audio.raw'))
      assert.equal(video.length, frames)
      assert.ok(audio.length / 2 >= frames / 30 * 48000 && audio.length / 2 < frames / 30 * 48000 + 1024, 'decoded AAC covers the duration, with at most one codec padding frame')
      const videoAt = video.findIndex(value => value > 100) / 30, expectedAt = (1.001 - 0.137) / speed
      let audioAt = -1
      for (let i = 0; i < audio.length; i += 2) if (Math.abs(audio.readInt16LE(i)) > 2000) { audioAt = i / 2 / 48000; break }
      assert.ok(Math.abs(videoAt - expectedAt) <= 1 / 30, `video keeps fractional seek phase (${videoAt} vs ${expectedAt})`)
      // Time stretching is not sample-exact; at normal speed no tempo filter may advance the tone.
      assert.ok(Math.abs(audioAt - expectedAt) < (speed === 1 ? 0.005 : 0.06), `audio onset stays aligned (${audioAt} vs ${expectedAt})`)
      assert.ok(Math.abs(videoAt - audioAt) < (speed === 1 ? 1 / 30 : 0.07), 'audio and video remain aligned across speed changes')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('native probe bounds edits by video, including Matroska tags and nonzero TS timestamps', { timeout: 120000 }, async t => {
  try { await dependencies() } catch (e) { if (e.code === 'missingDependency') return t.skip(e.message); throw e }
  const dir = mkdtempSync(join(tmpdir(), 'video-duration-test-')), run = { id: 'duration-test', dir, subject: { fields: { sourceFolder: dir, sourcePaths: 'long-audio.mp4\nlong-audio.mkv\nlong-audio.ts' } } }
  const ffmpeg = args => command('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...args])
  try {
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=160x128:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'long-audio.mp4')])
    for (const extension of ['mkv', 'ts']) await ffmpeg(['-i', join(dir, 'long-audio.mp4'), '-c', 'copy', join(dir, `long-audio.${extension}`)])
    const media = await ingest(run)
    for (const source of media) {
      assert.ok(source.duration >= 2 && source.duration < 2.025, `${source.name} uses the video endpoint relative to playback zero`)
      assert.ok(source.containerDuration > source.duration + 0.1, 'the longer audio track is recorded but cannot expand the edit')
      const timeline = initialTimeline([source], { duration: 10 })
      assert.equal(timeline.clips[0].out, source.duration)
      timeline.clips[0].out = source.containerDuration
      assert.throws(() => validateTimeline(timeline, [source]), /\.out/)
    }
    const timeline = initialTimeline(media, { duration: 10 })
    timeline.output = { ...timeline.output, width: 160, height: 128 }
    const result = await render(run, timeline, media)
    assert.equal(result.manifest.qa.decodedFrames, 180, 'all three video streams contribute exactly two seconds')
    assert.ok(Math.abs(result.info.duration - 6) < 0.001)
    assert.equal(result.manifest.sources[0].containerDuration, 2.4)
    assert.equal(result.manifest.sources[0].duration, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
test('native seeking preserves delayed audio instead of moving it to the clip start', { timeout: 120000 }, async t => {
  try { await dependencies() } catch (e) { if (e.code === 'missingDependency') return t.skip(e.message); throw e }
  const dir = mkdtempSync(join(tmpdir(), 'video-audio-offset-')), run = { id: 'audio-offset', dir, subject: { fields: { sourceFolder: dir, sourcePaths: 'delayed.mp4' } } }
  try {
    await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x128:r=30000/1001:d=4.004', '-itsoffset', '1', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'delayed.mp4')])
    const media = await ingest(run)
    const timeline = validateTimeline({ version: 1, output: { width: 160, height: 128, fps: 30, fit: 'contain', crf: 20 }, clips: [{ id: 'delay', source: media[0].id, in: 0.137, out: 2.137, speed: 1, volume: 1 }], captions: [] }, media)
    const result = await render(run, timeline, media)
    assert.equal(result.manifest.qa.decodedFrames, 60)
    await command('ffmpeg', ['-v', 'error', '-i', result.path, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', join(dir, 'audio.raw')])
    const audio = readFileSync(join(dir, 'audio.raw'))
    let audibleAt = -1
    for (let i = 0; i < audio.length; i += 2) if (Math.abs(audio.readInt16LE(i)) > 1500) { audibleAt = i / 2 / 48000; break }
    assert.ok(Math.abs(audibleAt - (1 - 0.137)) < 0.01, `the one-second audio offset survives the cut (${audibleAt})`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
