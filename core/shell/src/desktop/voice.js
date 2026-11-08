// Voice input (the page's side; voice.js on the Host): hold its key (the right ⌥ unless set otherwise in Settings →
// General → Voice input: ../../voice-key.js — or pressed once to start and again to end) — or press the microphone in
// the top bar — speak, let go: the words go where you were typing (an input, a text box, the conversation, the palette). With nothing
// to type into, they open the command palette (a page to open, or a question for the agent). The browser records
// (16 kHz mono WAV, what every speech endpoint takes); the Host transcribes through a connection.
import { HOTKEY_DEFAULT, hotkeyLabel, isHotkey } from '../../voice-key.js'

const RATE = 16000
const HOLD = 220 // ms the key is held before listening starts: a quick ⌥ with another key stays a shortcut

/** The element a dictation types into: an editable one, or none. */
const editable = el => !!el && el.isConnected && (el.isContentEditable || (el.tagName === 'TEXTAREA' && !el.readOnly && !el.disabled)
  || (el.tagName === 'INPUT' && !el.readOnly && !el.disabled && /^(text|search|url|email|)$/i.test(el.type || '')))

/** Float32 frames at `rate` → 16 kHz mono 16-bit WAV bytes. */
export function wavOf(chunks, rate) {
  const n = chunks.reduce((s, c) => s + c.length, 0), all = new Float32Array(n)
  let o = 0
  for (const c of chunks) { all.set(c, o); o += c.length }
  const ratio = rate / RATE, out = new Int16Array(Math.floor(n / ratio))
  for (let i = 0; i < out.length; i++) { // the mean of each window: a cheap low-pass before taking every ratio-th
    const a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = a; j < b; j++) s += all[j]
    const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  const buf = new ArrayBuffer(44 + out.length * 2), d = new DataView(buf)
  const str = (at, t) => [...t].forEach((ch, i) => d.setUint8(at + i, ch.charCodeAt(0)))
  str(0, 'RIFF'); d.setUint32(4, 36 + out.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ')
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, RATE, true); d.setUint32(28, RATE * 2, true)
  d.setUint16(32, 2, true); d.setUint16(34, 16, true); str(36, 'data'); d.setUint32(40, out.length * 2, true)
  new Int16Array(buf, 44).set(out)
  return new Uint8Array(buf)
}

/** The microphone, recording: { level() 0..1, stop() → WAV bytes, cancel() }. */
async function record() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
  let ac
  try { ac = new AudioContext() } catch (err) { stream.getTracks().forEach(t => t.stop()); throw err } // the microphone off again, whatever failed
  const src = ac.createMediaStreamSource(stream)
  // a script processor (no module to load: works under any page policy); its output stays silent
  const node = ac.createScriptProcessor(4096, 1, 1), mute = ac.createGain()
  mute.gain.value = 0
  const chunks = []
  let level = 0
  node.onaudioprocess = e => {
    const c = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(c))
    let s = 0
    for (let i = 0; i < c.length; i += 8) s += c[i] * c[i]
    level = Math.min(1, Math.sqrt(s / (c.length / 8)) * 6)
  }
  src.connect(node); node.connect(mute); mute.connect(ac.destination)
  const end = () => { node.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); ac.close().catch(() => {}) }
  return { level: () => level, stop: () => { const rate = ac.sampleRate; end(); return wavOf(chunks, rate) }, cancel: end, rate: ac.sampleRate, seconds: () => chunks.reduce((s, c) => s + c.length, 0) / ac.sampleRate }
}

const BUBBLE_CSS = `
.rx-heard { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 2147483000; max-width: min(560px, calc(100vw - 32px));
  display: flex; align-items: center; gap: 10px; padding: 10px 12px 10px 14px; border-radius: 14px; overflow: hidden;
  background: color-mix(in srgb, var(--ruyix-surface, #fff) 92%, transparent); color: var(--ruyix-text, #344256);
  box-shadow: 0 10px 30px rgb(0 0 0 / .22), 0 0 0 .5px var(--ruyix-line, #dfe4eb); backdrop-filter: blur(16px);
  font: 13px/1.4 system-ui, -apple-system, sans-serif; animation: rx-heard-in .18s ease-out; }
@keyframes rx-heard-in { from { opacity: 0; transform: translate(-50%, 8px); } }
.rx-heard-text { flex: 1; min-width: 0; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.rx-heard-text b { color: var(--ruyix-accent, #0f766e); font-weight: 600; margin-right: 4px; }
.rx-heard button { flex: none; height: 26px; padding: 0 10px; border-radius: 8px; border: .5px solid var(--ruyix-line, #dfe4eb);
  background: var(--ruyix-surface, #fff); color: inherit; font: inherit; font-size: 12px; cursor: pointer; }
.rx-heard button.rx-go { background: var(--ruyix-accent, #0f766e); color: var(--ruyix-on-primary, #fff); border-color: transparent; }
.rx-heard-bar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--ruyix-accent, #0f766e); animation: rx-heard-bar linear forwards; }
@keyframes rx-heard-bar { from { width: 100%; } to { width: 0; } }
`
const GRACE_MS = 2000 // the time to call a misheard sentence off before it goes

/**
 * What was heard, shown before it goes to the main agent: a bubble at the bottom with Cancel and Send, sent by itself
 * after GRACE_MS; then a line that it went, with the way to the chat. `send(text)` → whether it went.
 */
let bubbleOff = null // the bubble up now: called off (its timer too) when another comes — the newer words win
function heardBubble(text, { send, lang, openChat }) {
  if (!document.getElementById('rx-heard-css')) document.head.appendChild(Object.assign(document.createElement('style'), { id: 'rx-heard-css', textContent: BUBBLE_CSS }))
  bubbleOff?.()
  const zh = lang() === 'zh', el = document.createElement('div')
  el.className = 'rx-heard'
  el.setAttribute('role', 'status')
  const line = document.createElement('span')
  line.className = 'rx-heard-text'
  line.append(Object.assign(document.createElement('b'), { textContent: zh ? '听到' : 'Heard' }), `“${text}”`)
  const button = (label, cls, fn) => Object.assign(document.createElement('button'), { type: 'button', className: cls, textContent: label, onclick: fn })
  let timer = 0, done = false
  const close = () => { clearTimeout(timer); done = true; el.remove(); if (bubbleOff === close) bubbleOff = null }
  bubbleOff = close
  const go = () => {
    if (done) return
    done = true
    clearTimeout(timer)
    bubbleOff = () => { clearTimeout(timer); el.remove() } // (a line that it went: another bubble just takes its place)
    const sent = send(text)
    el.replaceChildren(Object.assign(document.createElement('span'), { className: 'rx-heard-text', textContent: sent ? (zh ? '交给主智能体了' : 'Sent to the main agent') : (zh ? '没能交出去：在 ⌘K 里' : 'Not sent: in ⌘K') }),
      ...(sent ? [button(zh ? '看对话' : 'Open the chat', '', () => { close(); openChat() })] : []))
    timer = setTimeout(close, 3500)
  }
  const bar = Object.assign(document.createElement('i'), { className: 'rx-heard-bar' })
  bar.style.animationDuration = `${GRACE_MS}ms`
  el.append(line, button(zh ? '取消' : 'Cancel', '', close), button(zh ? '发送' : 'Send', 'rx-go', go), bar)
  document.body.appendChild(el)
  timer = setTimeout(go, GRACE_MS)
  // Esc calls it off while it waits
  const esc = e => { if (e.key === 'Escape' && !done) { e.stopPropagation(); close() } }
  window.addEventListener('keydown', esc, true)
  new MutationObserver((_, mo) => { if (!el.isConnected) { window.removeEventListener('keydown', esc, true); mo.disconnect() } }).observe(document.body, { childList: true })
}

/**
 * The page's voice input: state { phase: 'idle' | 'listening' | 'working' | 'error', level, message } as a store;
 * start({ to? }), stop(), toggle({ to? }); the hold key. With nothing to type into, the words go to the main agent — `toAgent(text)`
 * (→ whether it could: the chat is here) after the heard bubble — else `toPalette(text)`.
 */
export function createVoiceInput({ toPalette, toAgent = null, openChat = () => {}, lang }) {
  let s = { phase: 'idle', level: 0, message: '' }, rec = null, generation = 0, target = null, route = null, meter = 0, holdTimer = 0, held = false, clear = 0
  const subs = new Set()
  const set = patch => { s = { ...s, ...patch }; subs.forEach(f => f()) }
  const fail = message => { set({ phase: 'error', message, level: 0 }); clearTimeout(clear); clear = setTimeout(() => s.phase === 'error' && set({ phase: 'idle', message: '' }), 4200) }
  // `to`: this time the words go there (a leaf's 接着问: its question) after the heard bubble, whatever has the focus
  async function start({ to = null } = {}) {
    if (rec || s.phase === 'listening' || s.phase === 'working') return
    const mine = ++generation
    route = typeof to === 'function' ? to : null
    target = !route && editable(document.activeElement) ? document.activeElement : null
    if (!navigator.mediaDevices?.getUserMedia) return fail(lang() === 'zh' ? '这个浏览器不能录音（需要 https 或本机地址）' : 'This browser cannot record here (it needs https or a local address)')
    set({ phase: 'listening', level: 0, message: '' })
    let opened
    try { opened = await record() } catch (err) {
      if (mine !== generation) return
      rec = null
      return fail(err?.name === 'NotAllowedError' ? (lang() === 'zh' ? '没有麦克风权限：在浏览器地址栏左边允许它' : 'No microphone permission: allow it left of the address bar') : (lang() === 'zh' ? `麦克风打不开：${err?.message || err}` : `The microphone did not open: ${err?.message || err}`))
    }
    if (mine !== generation || s.phase !== 'listening') { opened.cancel(); return }
    rec = opened // let go while the microphone was opening
    const tick = () => { if (!rec) return; set({ level: rec.level() }); meter = requestAnimationFrame(tick) }
    tick()
  }
  async function stop() {
    const mine = ++generation
    if (!rec) { if (s.phase === 'listening') set({ phase: 'idle' }); return }
    cancelAnimationFrame(meter)
    const r = rec
    rec = null
    if (r.seconds() < 0.35) { r.cancel(); return set({ phase: 'idle', level: 0 }) } // a tap, not speech
    const wav = r.stop()
    set({ phase: 'working', level: 0 })
    try {
      // the language spoken is the setting's (Settings → General), not the page's: an English page, Chinese words
      const res = await fetch('api/ruyix/voice', { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav })
      const d = await res.json().catch(() => ({}))
      if (mine !== generation) return
      if (!res.ok || d.error) throw new Error(d.params?.message || d.error || `HTTP ${res.status}`)
      const text = String(d.text || '').trim()
      set({ phase: 'idle', message: '' })
      if (!text) return
      if (route) heardBubble(text, { send: route, lang, openChat })
      else if (target && target.isConnected) {
        target.focus()
        // as typed: the page's own handlers see it (React's onChange too), undo takes it back
        if (!document.execCommand('insertText', false, text)) target.value = `${target.value || ''}${text}`
      } else if (toAgent && window.__ruyixChat) heardBubble(text, { send: t => (toAgent(t) ? true : (toPalette(t), false)), lang, openChat })
      else toPalette(text)
    } catch (err) { if (mine === generation) fail(String(err.message || err).slice(0, 200)) }
  }
  const toggle = opts => (rec || s.phase === 'listening' ? stop() : start(opts))
  // the key (the box's voice.json, the same in every browser; Settings says when it changes)
  let hotkey = HOTKEY_DEFAULT
  // its words for whatever names it (a widget's hint, a map's microphone): window.__ruyixVoiceKey = { hotkey, toggle,
  // say: { zh: '按住 右 ⌥' | '按一下 F8', en: 'hold right ⌥' | 'press F8' } } — the place adds "说完再按一下" when toggle; 'ruyix:voice-key'
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')
  const say = l => { const k = hotkeyLabel(hotkey, { lang: l, mac, bare: true }); return hotkey.mode === 'toggle' ? (l === 'zh' ? `按一下 ${k}` : `press ${k}`) : (l === 'zh' ? `按住 ${k}` : `hold ${k}`) }
  const publish = () => { window.__ruyixVoiceKey = { hotkey, toggle: hotkey.mode === 'toggle', say: { zh: say('zh'), en: say('en') } }; window.dispatchEvent(new Event('ruyix:voice-key')) }
  publish()
  const takeKey = c => { if (c?.hotkey?.code) { hotkey = c.hotkey; set({ hotkey }); publish() } }
  fetch('api/ruyix/voice/config').then(r => (r.ok ? r.json() : null)).then(takeKey, () => {})
  const onConfig = e => takeKey(e.detail)
  window.addEventListener('ruyix:voice-config', onConfig)
  const cancel = () => { ++generation; if (rec) { cancelAnimationFrame(meter); rec.cancel(); rec = null } set({ phase: 'idle', level: 0 }) }
  // held: listening after a moment, the words go at its release; another key while it is held makes it a shortcut again.
  // pressed (toggle): once to start, once more to end; Esc lets it go.
  const down = e => {
    if (window.__ruyixVoiceKeyCatching) return // (Settings is taking a new key)
    if (hotkey.mode === 'toggle') {
      if (isHotkey(e, hotkey) && !e.repeat) { e.preventDefault(); e.stopPropagation(); toggle() } else if (e.code === 'Escape' && (rec || s.phase === 'listening')) cancel()
      return
    }
    if (isHotkey(e, hotkey) && !e.repeat && !held) { held = true; if (hotkey.mods.length) { e.preventDefault(); e.stopPropagation() } holdTimer = setTimeout(() => { if (held) start() }, HOLD); return }
    if (held && e.code !== hotkey.code && !/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(e.code)) { held = false; clearTimeout(holdTimer); if (rec || s.phase === 'listening') cancel() }
  }
  const up = e => {
    if (hotkey.mode === 'toggle' || e.code !== hotkey.code || !held) return
    held = false
    clearTimeout(holdTimer)
    if (rec || s.phase === 'listening') { e.preventDefault(); stop() }
  }
  const blur = () => { if (held) { held = false; clearTimeout(holdTimer); if (rec || s.phase === 'listening') stop() } }
  window.addEventListener('keydown', down, true); window.addEventListener('keyup', up, true); window.addEventListener('blur', blur)
  return {
    get: () => s, subscribe: f => { subs.add(f); return () => subs.delete(f) }, start, stop, toggle, hotkey: () => hotkey,
    dispose() { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up, true); window.removeEventListener('blur', blur); window.removeEventListener('ruyix:voice-config', onConfig); held = false; clearTimeout(holdTimer); clearTimeout(clear); cancel() },
  }
}
