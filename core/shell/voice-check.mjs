// voice.js (the Host side of voice input) and the page's WAV encoding: the speech engine is found by its models, the
// request is the one Fonos sends (file, model, language), and what the engine says comes back as the words.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoice } from './voice.js'
import { wavOf } from './src/desktop/voice.js'

const home = mkdtempSync(join(tmpdir(), 'ruyix-voice-'))
try {
  // a connections service with two http connections: one speaks chat only, the other has speech models
  const sent = []
  const reply = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) })
  const models = { llm: ['qwen3-4b'], omlx: ['Qwen3-ASR-0.6B-bf16', 'qwen3-4b', 'Qwen3-ASR-1.7B-bf16', 'whisper-large-v3-turbo'] }
  const svc = {
    list: async () => [{ id: 'llm', type: 'http', name: 'LLM' }, { id: 'omlx', type: 'http', name: 'omlx' }, { id: 'gl', type: 'gitlab' }],
    client: id => ({
      async request(path, o = {}) {
        if (path === 'models') return reply(200, { data: models[id].map(m => ({ id: m })) })
        if (path === 'audio/transcriptions') { sent.push({ id, form: Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `${v.type}:${v.size}`])) }); return id === 'omlx' ? reply(200, { text: ' 你好 Ruyix ' }) : reply(404, { error: 'no' }) }
        return reply(404, {})
      },
    }),
  }
  let connectors = null
  const voice = createVoice({ home, connectors: () => connectors })
  await assert.rejects(voice.transcribe(new Uint8Array(10)), e => e.code === 'noEngine')
  connectors = svc

  const c = await voice.config()
  assert.deepEqual(c.choices.map(x => [x.kind, x.id, x.models]), [['connection', 'llm', []], ['connection', 'omlx', ['Qwen3-ASR-1.7B-bf16', 'Qwen3-ASR-0.6B-bf16', 'whisper-large-v3-turbo']]], 'speech models only, the larger ASR first')
  assert.deepEqual(c.using, { connection: 'omlx', model: 'Qwen3-ASR-1.7B-bf16', language: 'auto', chosen: false }, 'nothing set: the first connection with a speech model')

  const wav = wavOf([new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5)], 48000)
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), 'RIFF')
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000, '16 kHz')
  assert.equal(wav.length, 44 + 16000 * 2, 'one second of 48 kHz → 16000 samples of 16 bits')

  assert.deepEqual(await voice.transcribe(wav), { text: '你好 Ruyix', model: 'Qwen3-ASR-1.7B-bf16' })
  assert.deepEqual(sent.at(-1), { id: 'omlx', form: { file: `audio/wav:${wav.length}`, model: 'Qwen3-ASR-1.7B-bf16' } }, 'as Fonos sends it; no language when it is detected')

  await voice.save({ connection: 'omlx', model: 'whisper-large-v3-turbo', language: 'zh' })
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8')), { connection: 'omlx', model: 'whisper-large-v3-turbo', language: 'zh' })
  await voice.transcribe(wav)
  assert.deepEqual(sent.at(-1).form, { file: `audio/wav:${wav.length}`, model: 'whisper-large-v3-turbo', language: 'zh' }, 'the chosen model and language')

  await voice.save({ connection: 'llm', model: 'qwen3-4b' })
  await assert.rejects(voice.transcribe(wav), e => e.code === 'engine' && /answered 404/.test(e.message), 'what the engine said, not words')
  await assert.rejects(voice.save({ language: 'klingon' }), e => e.code === 'badVoice')
  await assert.rejects(voice.save({ connection: '../x' }), e => e.code === 'badVoice')
  // the key (voice-key.js): set alone, the rest kept; a plain key refused; null back to the right ⌥
  const kept = (await voice.config()).set
  assert.deepEqual((await voice.config()).hotkey, { code: 'AltRight', mods: [], mode: 'hold' })
  const k = await voice.save({ hotkey: { code: 'Space', mods: ['shift', 'meta'], mode: 'toggle' } })
  assert.deepEqual([k.hotkey, k.set.connection, k.set.model], [{ code: 'Space', mods: ['shift', 'meta'], mode: 'toggle' }, kept.connection, kept.model])
  assert.deepEqual((await voice.save({ connection: kept.connection, model: kept.model, language: 'en' })).hotkey.code, 'Space', 'choosing the model keeps the key')
  await assert.rejects(voice.save({ hotkey: { code: 'KeyA', mods: ['shift'] } }), e => e.code === 'badHotkey')
  assert.deepEqual((await voice.save({ hotkey: null })).hotkey, { code: 'AltRight', mods: [], mode: 'hold' })
  {
    const { checkHotkey, isHotkey, hotkeyLabel, hotkeyOf } = await import('./voice-key.js')
    assert.deepEqual([checkHotkey({ code: 'F8' }).ok, checkHotkey({ code: 'MetaRight', mods: ['meta'] }).hotkey.mods, checkHotkey({ code: 'KeyV', mods: ['ctrl', 'shift'] }).hotkey.mods, checkHotkey({ code: 'KeyV' }).why], [true, [], ['ctrl', 'shift'], 'plain'])
    const ev = (code, m = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m })
    assert.ok(isHotkey(ev('AltRight', { altKey: true }), { code: 'AltRight', mods: [] }), 'the right ⌥ held: its own ⌥ is not a second key')
    assert.ok(!isHotkey(ev('AltRight', { altKey: true, metaKey: true }), { code: 'AltRight', mods: [] }))
    assert.ok(isHotkey(ev('Space', { metaKey: true, shiftKey: true }), { code: 'Space', mods: ['shift', 'meta'] }))
    assert.deepEqual(hotkeyOf(ev('KeyD', { ctrlKey: true })), { code: 'KeyD', mods: ['ctrl'], mode: 'hold' })
    assert.deepEqual([hotkeyLabel({ code: 'AltRight', mods: [], mode: 'hold' }), hotkeyLabel({ code: 'Space', mods: ['shift', 'meta'], mode: 'toggle' }), hotkeyLabel({ code: 'F8', mods: [], mode: 'hold' }, { lang: 'en', mac: false })], ['按住 右 ⌥', '⇧⌘ 空格', 'Hold F8'])
  }
  await assert.rejects(voice.transcribe(new Uint8Array(0)), e => e.code === 'empty')
  await assert.rejects(voice.transcribe(new Uint8Array(25 << 20)), e => e.code === 'tooLong')

  // a model endpoint (dsh's providers, Settings → 模型): asked at its address with its key; chosen before a connection
  rmSync(join(home, 'voice.json'), { force: true })
  const asked = []
  const fetchFn = async (url, o = {}) => {
    asked.push([String(url), o.headers?.authorization || ''])
    if (String(url).endsWith('/models')) return reply(200, { data: String(url).includes('127.0.0.1') ? [{ id: 'qwen3-4b' }, { id: 'Qwen3-ASR-1.7B-bf16' }] : [{ id: 'deepseek-v4' }] })
    if (String(url).endsWith('/audio/transcriptions')) { sent.push({ id: 'provider', form: Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `${v.type}:${v.size}`])) }); return reply(200, { text: '把桌面换成极光' }) }
    return reply(404, {})
  }
  const providers = {
    omlx: { api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1/', apiKeyEnv: 'OMLX_API_KEY', models: [{ id: 'qwen3-4b' }] },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY', models: [{ id: 'deepseek-v4' }] }, // (pi-ai's catalog: its known address)
    ant: { api: 'anthropic-messages', baseURL: 'https://api.example.com/anthropic', apiKeyEnv: 'ANT_API_KEY', models: [] }, // (no /audio/transcriptions in that protocol)
  }
  const credentials = () => ({ resolve: async k => ({ OMLX_API_KEY: { value: 'local-key' }, DEEPSEEK_API_KEY: { value: 'NKBplaceholder' } })[k] })
  const pv = createVoice({ home, connectors: () => svc, providers: () => providers, credentials, fetchFn })
  const pc = await pv.config()
  assert.deepEqual(pc.choices.map(x => [x.kind, x.id, x.models]), [['provider', 'omlx', ['Qwen3-ASR-1.7B-bf16']], ['provider', 'deepseek', []], ['connection', 'llm', []], ['connection', 'omlx', ['Qwen3-ASR-1.7B-bf16', 'Qwen3-ASR-0.6B-bf16', 'whisper-large-v3-turbo']]])
  assert.ok(asked.some(([u, a]) => u === 'http://127.0.0.1:8000/v1/models' && a === 'Bearer local-key') && asked.some(([u, a]) => u === 'https://api.deepseek.com/v1/models' && a === 'Bearer NKBplaceholder'), 'each asked at its address with its key (a box\'s placeholder as kept)')
  assert.deepEqual(pc.using, { provider: 'omlx', model: 'Qwen3-ASR-1.7B-bf16', language: 'auto', chosen: false }, 'nothing set: a model endpoint first')
  assert.deepEqual(await pv.transcribe(wav), { text: '把桌面换成极光', model: 'Qwen3-ASR-1.7B-bf16' })
  assert.deepEqual(asked.at(-1), ['http://127.0.0.1:8000/v1/audio/transcriptions', 'Bearer local-key'])
  assert.deepEqual(sent.at(-1).form, { file: `audio/wav:${wav.length}`, model: 'Qwen3-ASR-1.7B-bf16' })
  await pv.save({ provider: 'omlx', model: 'Qwen3-ASR-1.7B-bf16', language: 'zh' })
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'voice.json'), 'utf8')), { provider: 'omlx', model: 'Qwen3-ASR-1.7B-bf16', language: 'zh' })
  await pv.save({ provider: 'gone', model: 'x' })
  await assert.rejects(pv.transcribe(wav), e => e.code === 'noEngine' && /gone/.test(e.message))
} finally { rmSync(home, { recursive: true, force: true }) }
console.log('ruyix voice check: ok')
