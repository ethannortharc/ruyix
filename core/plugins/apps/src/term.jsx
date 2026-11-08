// TermView: a terminal drawn by xterm.js, for the catalog's `term` apps (tmux, zellij). The host runs the multiplexer
// on a pseudo-terminal (lib/term.js); only text and the window's size go over the WebSocket, so the browser draws the
// letters itself — sharp at any size, the Mac's input method and clipboard as they are (no keysym typing, no pixels).
// The multiplexer keeps the shells: the window closing or the connection dropping only detaches; reconnecting (or
// opening again) shows them as they were. Its keys are the terminal's: ⌃ and ⌥ go to it (⌥ as Meta — zellij and
// tmux bind it), ⌘ stays the Mac's (⌘C copies a selection, ⌘V pastes, ⌘K the desktop's palette).
import { useEffect, useRef, useState } from 'react'
import { word } from './locale.js'
// xterm.js is bundled but loaded on first use (its modules run when the first terminal opens). Its DOM renderer, not
// the WebGL one: the desktop zooms its windows by the interface's size (CSS zoom), and the WebGL canvas, sized from
// the device pixels, is then drawn at the wrong scale (only a corner showed); the DOM's letters zoom as the page does.
const loadXterm = () => Promise.all([
  import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-web-links'), import('@xterm/addon-unicode11'), import('@xterm/addon-clipboard'),
]).then(([x, fit, links, uni, clip]) => ({ Terminal: x.Terminal, FitAddon: fit.FitAddon, WebLinksAddon: links.WebLinksAddon, Unicode11Addon: uni.Unicode11Addon, ClipboardAddon: clip.ClipboardAddon }))

export const TERM_PATH = 'ruyix-apps/term'
const DATA = 0, CONTROL = 1
const enc = new TextEncoder()
const FONT = '"JetBrains Mono", "SF Mono", SFMono-Regular, ui-monospace, Menlo, Monaco, "PingFang SC", "Noto Sans Mono CJK SC", monospace'

/** The ANSI colours, per tone: GitHub's (each readable on its ground). lib/term.js's zellij theme borrows the same. */
export const ANSI = {
  light: {
    black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
    brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#7d4e00', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#8c959f',
  },
  dark: {
    black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
    brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#ffffff',
  },
}

/** A CSS colour as #rrggbb ('' when it is not an opaque rgb()). */
const hexOf = rgb => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(String(rgb).trim())
  if (!m || (m[4] !== undefined && +m[4] < 1)) return ''
  return `#${[m[1], m[2], m[3]].map(v => (+v).toString(16).padStart(2, '0')).join('')}`
}
/**
 * The page's look now, from Ruyix's tokens as `el` sees them (the tone, the accent the desktop chose): the terminal's
 * ground and text, and what the host gives the multiplexer's bars.
 */
export function lookNow(el = document.body) {
  const probe = document.createElement('i')
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
  el.append(probe)
  const read = v => { probe.style.color = v; return hexOf(getComputedStyle(probe).color) }
  const tone = read('light-dark(rgb(0, 0, 0), rgb(255, 255, 255))') === '#ffffff' ? 'dark' : 'light'
  const look = { tone, bg: read('var(--ruyix-surface)'), fg: read('var(--ruyix-text)'), muted: read('var(--ruyix-text-muted)'), line: read('var(--ruyix-line)'), accent: read('var(--ruyix-accent)') }
  probe.remove()
  return look
}
/** xterm.js's theme for a look: Ruyix's ground and text, the accent for the cursor and the selection. */
export const themeOf = look => ({
  background: look.bg || (look.tone === 'dark' ? '#2b333f' : '#ffffff'),
  foreground: look.fg || (look.tone === 'dark' ? '#d9e3ef' : '#344256'),
  cursor: look.accent || undefined, cursorAccent: look.bg || undefined,
  selectionBackground: look.accent ? `${look.accent}40` : undefined,
  ...ANSI[look.tone === 'dark' ? 'dark' : 'light'],
})

/** The WebSocket's address for an app, its size and look (relative, as the API: a dsh under a path prefix works too). */
export function termUrl(appId, { cols, rows }, look, at = null) {
  const q = new URLSearchParams({ app: appId, cols: String(cols), rows: String(rows) })
  if (at?.session) q.set('session', at.session)
  if (at?.window != null) q.set('window', String(at.window))
  for (const [k, v] of Object.entries(look)) if (v) q.set(k, v)
  const u = new URL(`${TERM_PATH}?${q}`, document.baseURI)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.href
}

/**
 * { appId, active, lang, alive() → Promise<boolean>, onCloseWindow? } — `alive` asks the host whether the app's
 * session is still there (after the connection ended: the session gone says so, else reconnecting comes back to it).
 */
export function TermView({ appId, at = null, active, lang = 'zh', alive, onCloseWindow }) {
  const box = useRef(null), xt = useRef(null), sock = useRef(null)
  const [status, setStatus] = useState('connecting') // connecting | live | reconnecting | detached | ended | lost | failed
  const [why, setWhy] = useState('') // failed: what the host said
  const [round, setRound] = useState(0) // a new value connects again
  const tries = useRef(0)
  const w = k => word(lang, k)

  // the terminal itself, once per window: fitted to its box
  useEffect(() => {
    let gone = false, fit = null, ro = null
    loadXterm().then(X => {
      if (gone || !box.current) return
      const zoom = Number(getComputedStyle(document.body).getPropertyValue('--ruyix-scale')) || 1
      const t = new X.Terminal({
        fontFamily: FONT, fontSize: Math.round(13 * zoom), lineHeight: 1, letterSpacing: 0, // (1: the box lines of panes and frames come nearest to joining — the DOM renderer draws them from the font)
        cursorBlink: true, cursorStyle: 'bar', cursorInactiveStyle: 'outline',
        macOptionIsMeta: true, macOptionClickForcesSelection: true, rightClickSelectsWord: true,
        scrollback: 5000, allowProposedApi: true, drawBoldTextInBrightColors: false,
        theme: themeOf(lookNow(box.current)),
      })
      fit = new X.FitAddon()
      t.loadAddon(fit)
      t.loadAddon(new X.WebLinksAddon((e, uri) => { e.preventDefault(); window.open(uri, '_blank', 'noopener') }))
      t.loadAddon(new X.Unicode11Addon())
      t.unicode.activeVersion = '11' // (Chinese and emoji take two cells, as the shell counts them)
      t.loadAddon(new X.ClipboardAddon()) // OSC 52: what tmux or zellij copies reaches the Mac's clipboard
      t.open(box.current)
      t.textarea?.setAttribute('data-ruyix-keys', 'app') // ⌃K, ⌃, … are the terminal's, not the desktop's
      // ⌘: the Mac's, never the terminal's (⌘C and ⌘V still copy and paste: the browser's copy and paste events)
      t.attachCustomKeyEventHandler(e => !e.metaKey)
      t.onData(d => send(DATA, enc.encode(d)))
      t.onBinary(d => send(DATA, Uint8Array.from(d, c => c.charCodeAt(0) & 0xff)))
      t.onResize(({ cols, rows }) => send(CONTROL, enc.encode(`${cols} ${rows}`)))
      xt.current = { t, fit }
      fitNow()
      ro = new ResizeObserver(() => fitNow())
      ro.observe(box.current)
      setRound(n => n + 1) // (the connection waits for the terminal)
    }, err => { if (!gone) { console.error('apps: xterm.js did not load', err); setStatus('lost') } })
    return () => { gone = true; ro?.disconnect(); xt.current?.t.dispose(); xt.current = null }
  }, [appId])
  const send = (kind, bytes) => {
    const ws = sock.current
    if (ws?.readyState !== WebSocket.OPEN) return
    const m = new Uint8Array(bytes.length + 1)
    m[0] = kind; m.set(bytes, 1)
    ws.send(m)
  }
  const fitNow = () => { try { if (box.current?.offsetWidth) xt.current?.fit.fit() } catch { /* not laid out yet */ } }

  // the connection: one per round; the multiplexer redraws its screen when it attaches, so the terminal starts clean
  useEffect(() => {
    const x = xt.current
    if (!x || !round) return
    let gone = false, liveAt = 0, exit = null
    if (status !== 'connecting' && status !== 'reconnecting') setStatus('connecting')
    x.t.reset()
    const look = lookNow(box.current)
    x.t.options.theme = themeOf(look)
    const ws = new WebSocket(termUrl(appId, { cols: x.t.cols, rows: x.t.rows }, look, at))
    ws.binaryType = 'arraybuffer'
    sock.current = ws
    // (the size again once open: the window may have changed while it connected)
    ws.onopen = () => { liveAt = Date.now(); setStatus('live'); send(CONTROL, enc.encode(`${x.t.cols} ${x.t.rows}`)); if (active) x.t.focus() }
    ws.onmessage = e => {
      const b = new Uint8Array(e.data)
      if (b[0] === DATA) x.t.write(b.subarray(1))
      else if (b[0] === CONTROL) { try { exit = JSON.parse(new TextDecoder().decode(b.subarray(1))).exit } catch { /* not ours */ } }
    }
    ws.onclose = async e => {
      if (gone) return
      sock.current = null
      // the terminal did not start (1011): said as the host said it, not tried again
      if (e.code === 1011) { setWhy(e.reason || ''); setStatus('failed'); return }
      // the multiplexer ended on its own: detached (its session stays), or its last shell exited (the session ended)
      if (exit !== null) {
        setStatus('connecting') // (while the host is asked)
        const live = await Promise.resolve(alive?.()).catch(() => true)
        if (!gone) setStatus(live ? 'detached' : 'ended')
        return
      }
      // the connection dropped: once more at once (a connection that held a while starts its count again)
      if (liveAt && Date.now() - liveAt > 10000) tries.current = 0
      if (tries.current >= 1) { setStatus('lost'); return }
      tries.current += 1
      setStatus('reconnecting')
      setTimeout(() => { if (!gone) setRound(n => n + 1) }, 800)
    }
    return () => { gone = true; sock.current = null; try { ws.close() } catch { /* already gone */ } }
  }, [round])

  // the window coming to the front: the keyboard goes to the terminal, in the page's look (it may have changed)
  useEffect(() => {
    const x = xt.current
    if (!active || !x) return
    x.t.options.theme = themeOf(lookNow(box.current))
    if (status === 'live') x.t.focus()
  }, [active, status])

  const again = () => { tries.current = 0; setStatus('connecting'); setRound(n => n + 1) }
  return (
    <div className="ap-term" data-ruyix-keys="app" onMouseDown={() => xt.current?.t.focus()}>
      <div className="ap-term-screen" ref={box} />
      {status !== 'live' && (
        <div className={status === 'connecting' ? 'ap-term-note ap-term-note-quiet' : 'ap-term-note'} role="status">
          <span>{w(`term.${status}`)}</span>
          {status === 'failed' && why && <code className="ap-term-why">{why}</code>}
          {status !== 'connecting' && status !== 'reconnecting' && (
            <div className="ap-term-acts">
              <button className="ap-btn ap-primary" onClick={again}>{w(status === 'ended' ? 'term.new' : status === 'detached' ? 'term.attach' : 'term.retry')}</button>
              {onCloseWindow && <button className="ap-btn" onClick={onCloseWindow}>{w('vnc.closeWindow')}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
