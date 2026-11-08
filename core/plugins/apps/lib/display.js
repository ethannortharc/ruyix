// Display sessions: one graphical app on a virtual X display of its own. A session is three processes, all the box
// user's: Xvnc (an X server that is also a VNC server, on 127.0.0.1 only), matchbox (a window manager that gives the
// app's window the whole display, no title bar — the Ruyix window around it is the frame) and the app. The app
// exiting ends the session (the window manager and Xvnc are stopped); so does Xvnc dying. Several apps run at once,
// each on its own display :N (from :10) and VNC port 5900+N. The session's id is random: it rides in the WebSocket's
// URL, and dsh's sign-in (checked first) plus an id nobody can guess is what keeps another page off the display.
import { spawn as nodeSpawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

export const FIRST_DISPLAY = 10
export const LAST_DISPLAY = 99
export const vncPort = n => 5900 + n
export const GEOMETRY = '1280x800'

/** The desktop's accents (the shell's desktop.js ACCENTS) as libadwaita's own (GTK 4 apps: buttons, selection, switches). */
export const ADW_ACCENTS = { teal: 'teal', blue: 'blue', indigo: 'purple', rose: 'pink', amber: 'orange', graphite: 'slate', vermilion: 'red' }
/**
 * How an app is drawn: `pixels` X pixels per browser pixel (2: a Retina screen gets a display twice the window's size,
 * drawn at half — sharp), `zoom` the interface's size (the app's text and controls follow it), `tone` light or dark (the
 * page's), `accent` the desktop's accent (an id of ADW_ACCENTS; none: the app's own). Anything else: 1, 1, light, none.
 */
export function drawing({ pixels, zoom, tone, accent } = {}) {
  const p = Number(pixels) === 2 ? 2 : 1
  const z = Number(zoom)
  return { pixels: p, zoom: Number.isFinite(z) && z >= 0.75 && z <= 2 ? Math.round(z * 100) / 100 : 1, tone: tone === 'dark' ? 'dark' : 'light', accent: Object.hasOwn(ADW_ACCENTS, accent) ? accent : null }
}
/** What tells the app its size: GTK's scale (whole) and text scale, Qt's scale, and the display's DPI (Xft: xterm). */
export const scaleEnv = ({ pixels, zoom }) => ({ GDK_SCALE: String(pixels), GDK_DPI_SCALE: String(zoom), QT_SCALE_FACTOR: String(pixels * zoom), QT_AUTO_SCREEN_SCALE_FACTOR: '0' })
export const dpiOf = ({ pixels, zoom }) => Math.round(96 * pixels * zoom)

// ── the apps' look ──
// A box has no desktop environment, so nothing tells an app its theme, icons or fonts: GTK falls back to bare defaults
// (DejaVu, blurry old icons) and stays light. Each app is told at its start instead: GTK's settings files for its tone
// (Adwaita, light or dark; Papirus icons; Inter; no window buttons in a header bar — the Ruyix window has its own),
// libadwaita's colour scheme, the fonts' order (Inter, then Noto Sans CJK for Chinese; JetBrains Mono for code) and the
// software renderer for GTK 4 (the virtual display has no OpenGL: GTK 4 would draw a blank window). The settings go to
// XDG_CONFIG_DIRS ahead of the system's, so a person's own ~/.config/gtk-3.0/settings.ini still wins.
const GTK = {
  'gtk-theme-name': 'Adwaita', // GTK 3 (libadwaita ignores it, and warns when it is set: not in gtk-4.0's file)
  'gtk-icon-theme-name': 'Papirus',
  'gtk-font-name': 'Inter 10',
  'gtk-cursor-theme-name': 'Adwaita',
  'gtk-xft-antialias': 1, 'gtk-xft-hinting': 1, 'gtk-xft-hintstyle': 'hintslight', 'gtk-xft-rgba': 'none',
  'gtk-decoration-layout': 'menu:',
}
/** One settings.ini: GTK `version` 3 or 4, light or dark. */
export function gtkSettings(version, tone) {
  const keys = { ...GTK, ...(tone === 'dark' && { 'gtk-application-prefer-dark-theme': 1 }) }
  if (version === 4) delete keys['gtk-theme-name']
  return `[Settings]\n${Object.entries(keys).map(([k, v]) => `${k}=${v}`).join('\n')}\n`
}
// (the families before the system's file: its own preferences, read after, then go behind them)
export const FONTS_CONF = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <alias binding="strong"><family>sans-serif</family><prefer><family>Inter</family><family>Noto Sans CJK SC</family></prefer></alias>
  <alias binding="strong"><family>Sans</family><prefer><family>Inter</family><family>Noto Sans CJK SC</family></prefer></alias>
  <alias binding="strong"><family>monospace</family><prefer><family>JetBrains Mono</family><family>Noto Sans Mono CJK SC</family></prefer></alias>
  <alias binding="strong"><family>Monospace</family><prefer><family>JetBrains Mono</family><family>Noto Sans Mono CJK SC</family></prefer></alias>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
</fontconfig>
`
/** Writes the look's files under `dir` (each tone's GTK settings, the fonts' order); what is there already is kept. */
export function writeLook(dir) {
  const put = (file, text) => {
    try { if (readFileSync(file, 'utf8') === text) return } catch { /* not there yet */ }
    writeFileSync(file, text)
  }
  for (const tone of ['light', 'dark']) {
    for (const v of [3, 4]) {
      mkdirSync(join(dir, tone, `gtk-${v}.0`), { recursive: true })
      put(join(dir, tone, `gtk-${v}.0`, 'settings.ini'), gtkSettings(v, tone))
    }
  }
  put(join(dir, 'fonts.conf'), FONTS_CONF)
}
/** What tells an app its look (`dir`: writeLook's; `env`: the environment it starts from). */
export const lookEnv = ({ tone, accent }, dir, env = {}) => ({
  XDG_CONFIG_DIRS: [join(dir, tone), env.XDG_CONFIG_DIRS || '/etc/xdg'].join(delimiter),
  ADW_DEBUG_COLOR_SCHEME: `prefer-${tone}`,
  // libadwaita 1.6+ takes the accent from the desktop's settings portal, which a box has not: this says it instead
  ...(accent && { ADW_DEBUG_ACCENT_COLOR: ADW_ACCENTS[accent] }),
  FONTCONFIG_FILE: join(dir, 'fonts.conf'),
  GSK_RENDERER: 'cairo',
})

/** The full path of `cmd` on PATH ('' when it is not there). */
export function onPath(cmd, env = process.env) {
  for (const dir of String(env.PATH || '').split(delimiter).filter(Boolean)) {
    const f = join(dir, cmd)
    try { accessSync(f, constants.X_OK); return f } catch { /* next */ }
  }
  return ''
}

/** Whether display :n looks taken by someone else: an X lock file whose process is alive, or the socket. */
export function displayTaken(n) {
  const lock = `/tmp/.X${n}-lock`
  if (existsSync(lock)) {
    const pid = Number(String(readFileSync(lock, 'utf8')).trim())
    try { if (pid > 0) { process.kill(pid, 0); return true } } catch (err) { if (err.code === 'EPERM') return true }
    return false // a stale lock: Xvnc removes it itself
  }
  return existsSync(`/tmp/.X11-unix/X${n}`)
}

/** Resolves once something listens on 127.0.0.1:port (polls until `ms`; rejects after). */
export function waitForPort(port, { ms = 10000, every = 100, alive = () => true } = {}) {
  const until = Date.now() + ms
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      if (!alive()) return reject(new Error('the display server exited while starting'))
      const s = connect({ host: '127.0.0.1', port })
      s.once('connect', () => { s.destroy(); resolve() })
      s.once('error', () => { s.destroy(); if (Date.now() > until) reject(new Error(`no display server on port ${port} after ${ms} ms`)); else setTimeout(tryOnce, every) })
    }
    tryOnce()
  })
}

/** Xvnc's arguments for display :n (TigerVNC 1.15: X server options first, then its own parameters as -Name=value). */
export const xvncArgs = (n, d = drawing()) => [
  `:${n}`, '-geometry', GEOMETRY.split('x').map(v => v * d.pixels).join('x'), '-depth', '24', '-dpi', String(dpiOf(d)), '-nolisten', 'tcp', '-ac',
  '-SecurityTypes=None', '-localhost=1', `-rfbport=${vncPort(n)}`, '-AlwaysShared=1', '-AcceptSetDesktopSize=1',
  // a copy (⌘C, the app's own Ctrl+C) reaches the browser's clipboard; selecting text alone does not, as on a Mac
  '-SendPrimary=0',
]

/**
 * The sessions. `spawn` (node's by default) and `ready(port, { alive })` (waits for the VNC port) are injectable for
 * tests; `has(cmd)` says whether a program is installed (dbus-run-session wraps the app when it is).
 */
export function createDisplays({ spawn = nodeSpawn, ready = waitForPort, taken = displayTaken, has = cmd => !!onPath(cmd), env = process.env, home = homedir(), log = () => {}, stopGraceMs = 3000 } = {}) {
  const sessions = new Map() // id → session
  const listeners = new Set()
  const emit = () => { for (const f of listeners) { try { f() } catch { /* a listener's own */ } } }

  const freeDisplay = () => {
    const used = new Set([...sessions.values()].map(s => s.display))
    for (let n = FIRST_DISPLAY; n <= LAST_DISPLAY; n++) if (!used.has(n) && !taken(n)) return n
    throw Object.assign(new Error('no free display'), { code: 'noDisplay' })
  }
  // XDG_RUNTIME_DIR: the box user has no login session (no /run/user/<uid>); a private folder of our own instead
  const runtimeDir = () => {
    if (env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR)) return env.XDG_RUNTIME_DIR
    const d = join(tmpdir(), `ruyix-apps-${process.getuid?.() ?? 'user'}`)
    mkdirSync(d, { recursive: true, mode: 0o700 })
    return d
  }
  const start = (cmd, args, s, what) => {
    // its own process group: stopping the session stops what the app started too
    const p = spawn(cmd, args, { env: s.env, cwd: home, detached: true, stdio: 'ignore' })
    p.on?.('error', err => log(`apps: ${what} (${cmd}) on :${s.display}: ${err.message}`))
    return p
  }
  const signal = (p, sig) => {
    if (!p || p.exitCode != null || p.signalCode != null) return
    try { if (Number.isInteger(p.pid) && p.pid > 0) { process.kill(-p.pid, sig); return } } catch { /* no group: the process alone */ }
    try { p.kill(sig) } catch { /* gone */ }
  }
  const kill = p => {
    signal(p, 'SIGTERM')
    const t = setTimeout(() => signal(p, 'SIGKILL'), stopGraceMs)
    t.unref?.()
    p?.once?.('exit', () => clearTimeout(t))
  }
  /** End a session: the app, the window manager, then the display; said once. */
  const end = (s, why) => {
    if (s.state === 'ended') return
    s.state = 'ended'; s.why = why; s.endedAt = Date.now()
    sessions.delete(s.id)
    for (const p of [s.procs.app, s.procs.wm, s.procs.x]) kill(p)
    log(`apps: ${s.appId} on :${s.display} ended (${why})`)
    for (const f of s.ended) { try { f(why) } catch { /* the caller's */ } }
    emit()
  }

  /** Start an app (a catalog entry: { id, command, dark? }) on a display of its own, drawn as `how` says (drawing();
   * light whatever the page's tone for an app with `dark: false`) → the session (public view). An app already running
   * keeps how it was started. */
  async function launch(app, how) {
    const live = [...sessions.values()].find(s => s.appId === app.id)
    if (live) return view(live) // one at a time per app: the page brings its window to the front
    if (!Array.isArray(app.command) || !app.command.length) throw Object.assign(new Error(`${app.id} is not a graphical app`), { code: 'notGui' })
    const display = freeDisplay()
    const d = drawing({ ...how, ...(app.dark === false && { tone: 'light' }) })
    const look = join(runtimeDir(), 'look')
    try { writeLook(look) } catch (err) { log(`apps: the look's files (${look}): ${err.message}`) }
    const s = { id: randomBytes(18).toString('base64url'), appId: app.id, display, port: vncPort(display), state: 'starting', startedAt: Date.now(), procs: {}, ended: new Set(), ...d }
    s.env = { ...env, DISPLAY: `:${display}`, XDG_RUNTIME_DIR: runtimeDir(), XDG_SESSION_TYPE: 'x11', HOME: home, ...scaleEnv(d), ...lookEnv(d, look, env) }
    delete s.env.WAYLAND_DISPLAY
    sessions.set(s.id, s)
    emit()
    s.procs.x = start('Xvnc', xvncArgs(display, d), s, 'display')
    s.procs.x.on('exit', code => end(s, `display exited (${code ?? 'signal'})`))
    try {
      await ready(s.port, { alive: () => s.state !== 'ended' })
    } catch (err) {
      end(s, `display did not start: ${err.message}`)
      throw Object.assign(new Error(`the display did not start: ${err.message}`), { code: 'displayFailed' })
    }
    if (s.state === 'ended') throw Object.assign(new Error(`the display did not start: ${s.why}`), { code: 'displayFailed' })
    s.procs.wm = start('matchbox-window-manager', ['-use_titlebar', 'no'], s, 'window manager')
    // its own session bus, gone when the app is (GTK apps and Firefox want one)
    const [cmd, ...args] = has('dbus-run-session') ? ['dbus-run-session', '--', ...app.command] : app.command
    s.procs.app = start(cmd, args, s, app.id)
    s.procs.app.on('exit', code => end(s, `app exited (${code ?? 'signal'})`))
    s.state = 'running'
    emit()
    return view(s)
  }
  const view = s => ({ id: s.id, appId: s.appId, display: s.display, state: s.state, startedAt: s.startedAt, pixels: s.pixels, zoom: s.zoom, tone: s.tone, accent: s.accent })
  return {
    launch,
    /** End a session by id (true when there was one). */
    stop(id) { const s = sessions.get(String(id)); if (!s) return false; end(s, 'stopped'); return true },
    stopAll() { for (const s of [...sessions.values()]) end(s, 'stopped') },
    list: () => [...sessions.values()].map(view),
    /** The live session for an id, with its VNC port (for the bridge) and onEnd(fn → unsubscribe). */
    get(id) {
      const s = sessions.get(String(id ?? ''))
      return s && { ...view(s), port: s.port, onEnd: f => { s.ended.add(f); return () => s.ended.delete(f) } }
    },
    subscribe: f => { listeners.add(f); return () => listeners.delete(f) },
  }
}
