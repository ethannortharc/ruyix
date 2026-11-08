// Self-check: the catalog, the WebSocket framing (over a real socket pair), the bridge end to end against a fake VNC
// server, display sessions with an injected spawn, installing through a fake nookbox window, the routes, and the
// page's words. `node check.mjs`
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { appBy, apply, removable, systemTools, termUpgrade, vncUpgrade } from './index.js'
import { CATALOG, CATEGORIES, GUI_SUPPORT, PACKAGE, checkPackages } from './lib/catalog.js'
import { createWindows, folderOf } from './lib/xwin.js'
import { appFinder, systemTools as appTools } from './index.js'
import { createMade, idOf, madeTools, MAX_HTML } from './lib/made.js'
import { createPieces } from './lib/pieces.js'
import { ADW_ACCENTS, createDisplays, dpiOf, drawing, gtkSettings, lookEnv, scaleEnv, vncPort, xvncArgs } from './lib/display.js'
import { ACCENTS } from '../../shell/desktop.js'
import { installedOf } from './lib/install.js'
import { LOOK, MSG, TMUX_SOCKET, createTerms, lookOf, muxes, parseMessage, parseSize, termEnv, tmuxConf, zellijTheme } from './lib/term.js'
import { OP, acceptKey, encodeFrame, frameReader, handshake, wsConnection } from './lib/ws.js'
import { SPARE, XK_RETURN, XK_TAB, isTextKey, keysymOf, keysymsOf, viaClipboard } from './src/keys.js'
import { en, zh } from './src/locale.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (fn, what, ms = 3000) => { const end = Date.now() + ms; while (!(await fn())) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10) } }
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)))

// ── the catalog ──
// every package as checked on Debian trixie main (arm64 + amd64, or arch all) on 2026-10-14: a new one is checked too
const TRIXIE = new Set(['xterm', 'mousepad', 'geany', 'firefox-esr', 'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress', 'gimp', 'inkscape', 'evince',
  'thunar', 'ffmpeg', 'imagemagick', 'pandoc', 'yt-dlp', 'ripgrep', 'jq', 'sqlite3', 'poppler-utils', 'tesseract-ocr', 'tesseract-ocr-chi-sim', 'git-lfs',
  'tigervnc-standalone-server', 'matchbox-window-manager', 'fonts-noto-cjk', 'dbus-x11', 'xauth',
  // 2026-10-15 (apt-cache policy in a trixie box, arm64; arch all or both arches on packages.debian.org)
  'gnome-console', 'nautilus', 'gnome-text-editor', 'gnome-calculator', 'papers', 'loupe', 'libreoffice-gtk3',
  'adwaita-icon-theme', 'papirus-icon-theme', 'librsvg2-common', 'fonts-inter', 'fonts-jetbrains-mono',
  // 2026-10-17 (api.ftp-master.debian.org madison, trixie, arm64 and amd64)
  'tmux'])

{
  const ids = CATALOG.map(a => a.id)
  assert.equal(new Set(ids).size, ids.length, 'catalog ids are unique')
  const icons = new Set(readFileSync('src/main.jsx', 'utf8').match(/const ICONS = \{([^}]*)\}/)[1].split(',').map(s => s.trim()))
  for (const a of CATALOG) {
    assert.match(a.id, /^[a-z0-9-]+$/, a.id)
    assert.ok(a.name.zh && a.name.en && a.summary.zh && a.summary.en, `${a.id}: zh and en words`)
    assert.ok(['gui', 'cli', 'term'].includes(a.kind), `${a.id}: kind`)
    // (a terminal may have none: zellij comes with the image, not from Debian; nor the agents' browser: Playwright's Chromium)
    assert.ok((a.packages.length || a.kind === 'term' || a.image) && a.packages.every(p => PACKAGE.test(p) && TRIXIE.has(p)), `${a.id}: packages checked in trixie`)
    assert.ok(a.kind === 'gui' ? Array.isArray(a.command) && a.command.length && a.command.every(x => typeof x === 'string') : a.command === null, `${a.id}: command`)
    if (a.kind === 'term') assert.ok(['tmux', 'zellij'].includes(a.mux) && (a.packages.includes(a.mux) || !a.packages.length) && a.terminal, `${a.id}: its multiplexer`)
    assert.ok(icons.has(a.icon), `${a.id}: icon ${a.icon} is one the page draws`)
    assert.ok(CATEGORIES.includes(a.category) && zh[`cat.${a.category}`] && en[`cat.${a.category}`], `${a.id}: category`)
  }
  assert.ok(GUI_SUPPORT.every(p => TRIXIE.has(p)))
  assert.ok(CATALOG.filter(a => a.kind === 'gui').length >= 8 && CATALOG.filter(a => a.kind === 'cli').length >= 8)
  assert.deepEqual(checkPackages(['jq', 'jq', ' htop ']), ['jq', 'htop'])
  for (const bad of [['Foo'], ['-rf'], ['a'], ['x;rm'], ['ok', '../x'], [], Array.from({ length: 25 }, (_, i) => `p${i}x`), ['a'.repeat(65)]]) {
    assert.throws(() => checkPackages(bad), e => e.code === 'badPackage', JSON.stringify(bad).slice(0, 40))
  }
  assert.ok(PACKAGE.test('g++') && PACKAGE.test('libc6.1') && PACKAGE.test('0ad'))
}

// ── WebSocket framing ──
// the RFC's own example
assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
{
  const req = h => ({ method: 'GET', headers: { upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...h } })
  const ok = handshake(req({ 'sec-websocket-protocol': 'base64, binary' }))
  assert.match(ok.response, /^HTTP\/1\.1 101 Switching Protocols\r\n/)
  assert.ok(ok.response.includes('\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n'))
  assert.match(ok.response, /\r\nSec-WebSocket-Protocol: binary\r\n\r\n$/)
  assert.doesNotMatch(handshake(req({})).response, /Sec-WebSocket-Protocol/, 'no protocol offered: none chosen')
  assert.equal(handshake(req({ 'sec-websocket-version': '8' })).status, 426)
  assert.equal(handshake(req({ 'sec-websocket-key': 'short' })).status, 400)
  assert.equal(handshake({ ...req({}), method: 'POST' }).status, 405)
  assert.equal(handshake(req({ upgrade: 'h2c' })).status, 400)
}
// the reader by itself: lengths of every size, split anywhere
{
  const mask = Buffer.from([1, 2, 3, 4])
  for (const n of [0, 5, 125, 126, 65535, 65536, 70000]) {
    const data = Buffer.alloc(n, 7)
    const bytes = encodeFrame(OP.BINARY, data, { mask })
    const read = frameReader()
    const got = [...read(bytes.subarray(0, 1)), ...read(bytes.subarray(1, 3)), ...read(bytes.subarray(3))]
    assert.equal(got.length, 1); assert.ok(got[0].payload.equals(data), `length ${n}`)
  }
  assert.throws(() => frameReader()(encodeFrame(OP.BINARY, Buffer.from('x'))), e => e.closeCode === 1002, 'an unmasked client frame')
  assert.throws(() => frameReader({ max: 10 })(encodeFrame(OP.BINARY, Buffer.alloc(11), { mask })), e => e.closeCode === 1009)
  assert.throws(() => frameReader()(encodeFrame(OP.PING, Buffer.alloc(126), { mask })), e => e.closeCode === 1002, 'a long control frame')
}

/** A socket pair: the server side runs wsConnection (as after a handshake), the client side reads frames. */
async function pair(opts = {}) {
  const got = { messages: [], closed: null }
  let server
  const tcp = createTcpServer(sock => { server = wsConnection(sock, Buffer.alloc(0), { pingMs: 0, ...opts, onMessage: m => got.messages.push(m), onClose: (c, r) => { got.closed = { code: c, reason: r } } }) })
  const port = await listen(tcp)
  const client = connect({ port, host: '127.0.0.1' })
  await new Promise(r => client.once('connect', r))
  await until(() => server, 'server side')
  const read = frameReader({ requireMask: false })
  const frames = [], ended = { v: false }
  client.on('data', d => frames.push(...read(d)))
  client.on('close', () => { ended.v = true })
  const mask = () => Buffer.from([Math.random() * 256, 9, 77, 200].map(Math.floor))
  const send = (op, data, o = {}) => client.write(encodeFrame(op, data, { mask: mask(), ...o }))
  return { got, server: () => server, client, frames, ended, send, done: () => { client.destroy(); tcp.close() } }
}
{
  // a masked binary message
  const p = await pair()
  p.send(OP.BINARY, Buffer.from('hello'))
  await until(() => p.got.messages.length === 1, 'message')
  assert.equal(p.got.messages[0].toString(), 'hello')
  // the server's frames are unmasked binary
  p.server().send(Buffer.from([1, 2, 3]))
  await until(() => p.frames.length === 1, 'server frame')
  assert.deepEqual(p.frames[0], { fin: true, opcode: OP.BINARY, payload: Buffer.from([1, 2, 3]) })
  // ping → pong with its payload
  p.send(OP.PING, Buffer.from('are you there'))
  await until(() => p.frames.length === 2, 'pong')
  assert.equal(p.frames[1].opcode, OP.PONG); assert.equal(p.frames[1].payload.toString(), 'are you there')
  // a fragmented message, a ping between its parts: one message, the pong at once
  p.send(OP.BINARY, Buffer.from('frag'), { fin: false })
  p.send(OP.PING, Buffer.from('mid'))
  p.send(OP.CONT, Buffer.from('men'), { fin: false })
  p.send(OP.CONT, Buffer.from('ted'))
  await until(() => p.got.messages.length === 2, 'fragmented message')
  assert.equal(p.got.messages[1].toString(), 'fragmented')
  assert.equal(p.frames[2].opcode, OP.PONG); assert.equal(p.frames[2].payload.toString(), 'mid')
  // the client closes: the close is echoed with its code, the socket ends
  const body = Buffer.alloc(2); body.writeUInt16BE(1000)
  p.send(OP.CLOSE, body)
  await until(() => p.ended.v, 'socket ended')
  assert.equal(p.frames.at(-1).opcode, OP.CLOSE); assert.equal(p.frames.at(-1).payload.readUInt16BE(0), 1000)
  assert.equal(p.got.closed.code, 1000)
  p.done()
}
for (const [what, act, code] of [
  ['an unmasked frame', p => p.client.write(encodeFrame(OP.BINARY, Buffer.from('x'))), 1002],
  ['a text message', p => p.send(OP.TEXT, Buffer.from('hi')), 1003],
  ['a continuation out of nowhere', p => p.send(OP.CONT, Buffer.from('x')), 1002],
  ['a new message inside a fragmented one', p => { p.send(OP.BINARY, Buffer.from('a'), { fin: false }); p.send(OP.BINARY, Buffer.from('b')) }, 1002],
  ['an unknown opcode', p => p.send(0x3, Buffer.from('x')), 1002],
  ['a message too large', p => { p.send(OP.BINARY, Buffer.alloc(8), { fin: false }); p.send(OP.CONT, Buffer.alloc(8)) }, 1009],
]) {
  const p = await pair({ max: 10 })
  act(p)
  await until(() => p.frames.some(f => f.opcode === OP.CLOSE), what)
  assert.equal(p.frames.find(f => f.opcode === OP.CLOSE).payload.readUInt16BE(0), code, what)
  assert.equal(p.got.messages.length, 0, what)
  p.done()
}
{
  // the server's own keep-alive ping
  const p = await pair({ pingMs: 30 })
  await until(() => p.frames.some(f => f.opcode === OP.PING), 'a ping from the server')
  // a peer that answers nothing for two pings (the network gone: no FIN ever comes) is dropped
  await until(() => p.got.closed, 'a silent peer dropped', 3000)
  assert.equal(p.got.closed.code, 1006)
  p.done()
  // one that answers stays
  const q = await pair({ pingMs: 30 })
  const pong = setInterval(() => q.send(OP.PONG, Buffer.alloc(0)), 20)
  await sleep(1300)
  assert.equal(q.got.closed, null, 'a peer that answers is kept')
  clearInterval(pong); q.done()
}

// ── the bridge, end to end: browser → dsh's upgrade route → a fake VNC server ──
{
  const vnc = { got: [], socks: [] }
  const vncServer = createTcpServer(s => { vnc.socks.push(s); s.write('RFB 003.008\n'); s.on('data', d => vnc.got.push(d)) })
  const vncPortNo = await listen(vncServer)
  const ends = new Map()
  const displays = {
    get: id => id === 'sess-ok' || id === 'sess-down' ? { id, state: 'running', port: id === 'sess-ok' ? vncPortNo : 1, onEnd: f => { ends.set(id, f); return () => ends.delete(id) } } : undefined,
  }
  let admitted = true
  const open = new Set()
  const web = createServer((_q, s) => s.end())
  web.on('upgrade', vncUpgrade({ displays, admit: req => (admitted ? { ok: true } : { rejection: 401 }), open, pingMs: 0 }))
  const webPort = await listen(web)
  const KEY = Buffer.from('0123456789abcdef').toString('base64')
  /** A raw WebSocket client: the HTTP answer, then frames. */
  async function dial(path, { protocol = 'binary' } = {}) {
    const s = connect({ port: webPort, host: '127.0.0.1' })
    await new Promise(r => s.once('connect', r))
    s.write([`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${webPort}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${KEY}`, 'Sec-WebSocket-Version: 13',
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'))
    let raw = Buffer.alloc(0), head = null
    const frames = [], read = frameReader({ requireMask: false })
    const st = { ended: false }
    s.on('data', d => {
      if (head === null) {
        raw = Buffer.concat([raw, d])
        const at = raw.indexOf('\r\n\r\n')
        if (at < 0) return
        head = raw.subarray(0, at).toString(); d = raw.subarray(at + 4)
      }
      if (d.length) frames.push(...read(d))
    })
    s.on('close', () => { st.ended = true })
    await until(() => head !== null || st.ended, 'an HTTP answer')
    return { s, head: head || '', frames, st, send: data => s.write(encodeFrame(OP.BINARY, data, { mask: Buffer.from([9, 8, 7, 6]) })) }
  }
  const c = await dial('/ruyix-apps/vnc?s=sess-ok')
  assert.match(c.head, /^HTTP\/1\.1 101 /)
  assert.match(c.head, new RegExp(`Sec-WebSocket-Accept: ${acceptKey(KEY).replace(/[+/]/g, m => `\\${m}`)}`))
  assert.match(c.head, /Sec-WebSocket-Protocol: binary/)
  // the VNC server's greeting arrives as a binary message; the browser's bytes reach it
  await until(() => c.frames.length, 'the greeting')
  assert.equal(c.frames[0].opcode, OP.BINARY); assert.equal(c.frames[0].payload.toString(), 'RFB 003.008\n')
  c.send(Buffer.from('RFB 003.008\n'))
  await until(() => Buffer.concat(vnc.got).toString() === 'RFB 003.008\n', 'the browser\'s bytes at the VNC server')
  // a large update from the VNC side, split into many TCP reads, arrives whole
  const big = Buffer.alloc(300_000, 5)
  vnc.socks[0].write(big)
  await until(() => Buffer.concat(c.frames.slice(1).map(f => f.payload)).length === big.length, 'a large update')
  assert.equal(open.size, 1)
  // the session ending closes the browser's side (1000) and the TCP side
  ends.get('sess-ok')()
  await until(() => c.st.ended, 'the WebSocket closed when the session ended')
  const close = c.frames.find(f => f.opcode === OP.CLOSE)
  assert.equal(close.payload.readUInt16BE(0), 1000); assert.match(close.payload.subarray(2).toString(), /app has closed/)
  await until(() => vnc.socks[0].destroyed || vnc.socks[0].readableEnded, 'the TCP side ended')
  await until(() => open.size === 0, 'the bridge forgotten')
  // the VNC server going away closes the browser's side too
  const c2 = await dial('/ruyix-apps/vnc?s=sess-ok', { protocol: null })
  assert.doesNotMatch(c2.head, /Sec-WebSocket-Protocol/)
  await until(() => vnc.socks.length === 2, 'second connection')
  vnc.socks[1].destroy()
  await until(() => c2.st.ended, 'closed when the display went')
  // a display that does not answer: 1011
  const c3 = await dial('/ruyix-apps/vnc?s=sess-down')
  await until(() => c3.st.ended, 'closed: nothing at the port')
  assert.equal(c3.frames.find(f => f.opcode === OP.CLOSE).payload.readUInt16BE(0), 1011)
  // no such session: 404; not signed in: dsh's refusal, before anything else
  assert.match((await dial('/ruyix-apps/vnc?s=guess')).head, /^HTTP\/1\.1 404 /)
  assert.match((await dial('/ruyix-apps/vnc')).head, /^HTTP\/1\.1 404 /)
  admitted = false
  assert.match((await dial('/ruyix-apps/vnc?s=sess-ok')).head, /^HTTP\/1\.1 401 /)
  web.close(); vncServer.close()
}

// ── display sessions, with an injected spawn ──
function fakeSpawner() {
  const calls = []
  const spawn = (cmd, args, opts) => {
    const p = new EventEmitter()
    Object.assign(p, { cmd, args, opts, exitCode: null, signals: [] })
    p.kill = sig => { p.signals.push(sig); if (p.exitCode === null && !p.stubborn) { p.exitCode = 0; setImmediate(() => p.emit('exit', null, sig)) } }
    p.exit = code => { p.exitCode = code; p.emit('exit', code, null) }
    calls.push(p)
    return p
  }
  return { spawn, calls, of: (display, cmd) => calls.filter(p => p.opts.env.DISPLAY === `:${display}` && p.cmd === cmd).at(-1) }
}
{
  assert.deepEqual(xvncArgs(10), [':10', '-geometry', '1280x800', '-depth', '24', '-dpi', '96', '-nolisten', 'tcp', '-ac', '-SecurityTypes=None', '-localhost=1', '-rfbport=5910', '-AlwaysShared=1', '-AcceptSetDesktopSize=1', '-SendPrimary=0'])
  // how an app is drawn: Retina (2 pixels) and the interface's size, light or dark, anything odd falls back
  assert.deepEqual(drawing(), { pixels: 1, zoom: 1, tone: 'light', accent: null })
  assert.deepEqual(drawing({ pixels: 2, zoom: 1.25 }), { pixels: 2, zoom: 1.25, tone: 'light', accent: null })
  assert.deepEqual(drawing({ pixels: 3, zoom: 9 }), { pixels: 1, zoom: 1, tone: 'light', accent: null }, 'only 1 or 2 pixels, a zoom of 0.75–2')
  assert.deepEqual(drawing({ pixels: '2', zoom: 'x' }), { pixels: 2, zoom: 1, tone: 'light', accent: null })
  assert.equal(dpiOf({ pixels: 2, zoom: 1.25 }), 240)
  assert.deepEqual(scaleEnv({ pixels: 2, zoom: 1.1 }), { GDK_SCALE: '2', GDK_DPI_SCALE: '1.1', QT_SCALE_FACTOR: '2.2', QT_AUTO_SCREEN_SCALE_FACTOR: '0' })
  assert.deepEqual(xvncArgs(11, { pixels: 2, zoom: 1 }).slice(0, 7), [':11', '-geometry', '2560x1600', '-depth', '24', '-dpi', '192'], 'a sharp display starts twice the size')
  assert.deepEqual(drawing({}), { pixels: 1, zoom: 1, tone: 'light', accent: null })
  assert.equal(drawing({ tone: 'dark' }).tone, 'dark'); assert.equal(drawing({ tone: 'purple' }).tone, 'light')
  assert.match(gtkSettings(3, 'dark'), /^\[Settings\]\ngtk-theme-name=Adwaita\n[^]*gtk-application-prefer-dark-theme=1\n$/)
  assert.ok(!gtkSettings(4, 'light').includes('gtk-theme-name') && !gtkSettings(4, 'light').includes('prefer-dark'), "GTK 4's file: no theme name (libadwaita warns), light")
  const f = fakeSpawner(), readyAsked = []
  const busyDisplays = new Set([12])
  const runtime = mkdtempSync(join(tmpdir(), 'ruyix-apps-check-'))
  const d = createDisplays({ spawn: f.spawn, ready: async port => { readyAsked.push(port) }, taken: n => busyDisplays.has(n), has: c => c === 'dbus-run-session', env: { PATH: '/usr/bin', WAYLAND_DISPLAY: 'w', XDG_RUNTIME_DIR: runtime }, home: '/home/nook', stopGraceMs: 50 })
  const xterm = CATALOG.find(a => a.id === 'xterm'), gimp = CATALOG.find(a => a.id === 'gimp'), geany = CATALOG.find(a => a.id === 'geany')
  const a = await d.launch(xterm)
  assert.equal(a.display, 10); assert.equal(a.state, 'running'); assert.deepEqual(readyAsked, [5910])
  assert.ok(a.id.length >= 24 && /^[A-Za-z0-9_-]+$/.test(a.id), 'an unguessable id')
  const x = f.of(10, 'Xvnc'), wm = f.of(10, 'matchbox-window-manager'), app = f.of(10, 'dbus-run-session')
  assert.deepEqual(x.args, xvncArgs(10))
  assert.deepEqual(wm.args, ['-use_titlebar', 'no'])
  assert.deepEqual(app.args, ['--', ...xterm.command], 'the app in a session bus of its own')
  assert.ok(f.calls.every(p => p.opts.detached && p.opts.cwd === '/home/nook' && p.opts.env.DISPLAY === ':10' && p.opts.env.XDG_RUNTIME_DIR && !('WAYLAND_DISPLAY' in p.opts.env)))
  assert.deepEqual(await d.launch(xterm), a, 'the same app again: the same session')
  const b = await d.launch(gimp, { tone: 'dark', accent: 'rose' })
  assert.equal(b.display, 11)
  assert.equal(b.tone, 'dark'); assert.equal(b.accent, 'rose')
  assert.equal(f.of(11, 'dbus-run-session').opts.env.ADW_DEBUG_ACCENT_COLOR, 'pink', 'in the desktop\'s accent')
  assert.deepEqual([f.of(11, 'dbus-run-session').opts.env.XDG_CONFIG_DIRS.split(delimiter)[0], f.of(11, 'dbus-run-session').opts.env.ADW_DEBUG_COLOR_SCHEME], [join(runtime, 'look', 'dark'), 'prefer-dark'], 'a dark page: a dark app')
  {
    // LibreOffice stays light (dark: false): its icons are unreadable on the dark theme
    const f3 = fakeSpawner(), d3 = createDisplays({ spawn: f3.spawn, ready: async () => {}, taken: () => false, has: () => false, env: { PATH: '', XDG_RUNTIME_DIR: runtime } })
    assert.equal((await d3.launch(CATALOG.find(a => a.id === 'libreoffice'), { tone: 'dark' })).tone, 'light')
    assert.equal(f3.of(10, 'libreoffice').opts.env.ADW_DEBUG_COLOR_SCHEME, 'prefer-light')
    d3.stopAll()
  }
  const c = await d.launch(geany, { pixels: 2, zoom: 1.25 })
  assert.equal(c.display, 13, 'a display someone else holds is skipped')
  assert.deepEqual([c.pixels, c.zoom], [2, 1.25], 'the session says how it is drawn')
  assert.deepEqual(f.of(13, 'Xvnc').args, xvncArgs(13, { pixels: 2, zoom: 1.25 }))
  assert.equal(f.of(13, 'dbus-run-session').opts.env.GDK_SCALE, '2', 'the app is told its scale')
  assert.equal(f.of(10, 'dbus-run-session').opts.env.GDK_SCALE, '1')
  // the look: GTK's settings for the page's tone ahead of the system's, libadwaita's scheme, the fonts' order, GTK 4 drawn
  // without OpenGL — the files written where the session's runtime folder is
  const look = join(runtime, 'look'), e10 = f.of(10, 'dbus-run-session').opts.env
  assert.deepEqual([e10.XDG_CONFIG_DIRS, e10.ADW_DEBUG_COLOR_SCHEME, e10.FONTCONFIG_FILE, e10.GSK_RENDERER], [`${join(look, 'light')}${delimiter}/etc/xdg`, 'prefer-light', join(look, 'fonts.conf'), 'cairo'])
  for (const t of ['light', 'dark']) for (const v of [3, 4]) assert.equal(readFileSync(join(look, t, `gtk-${v}.0`, 'settings.ini'), 'utf8'), gtkSettings(v, t))
  assert.match(readFileSync(join(look, 'fonts.conf'), 'utf8'), /<family>Inter<\/family>[^]*<include ignore_missing="yes">\/etc\/fonts\/fonts.conf<\/include>/)
  assert.notEqual(a.id, b.id)
  assert.equal(d.get(b.id).port, vncPort(11))
  assert.deepEqual(d.list().map(s => s.appId), ['xterm', 'gimp', 'geany'])
  // the app exiting ends the session: the window manager and the display are stopped
  let endedWhy = null
  d.get(a.id).onEnd(why => { endedWhy = why })
  app.exit(0)
  assert.match(endedWhy, /app exited/)
  assert.deepEqual(x.signals, ['SIGTERM']); assert.deepEqual(wm.signals, ['SIGTERM'])
  assert.equal(d.get(a.id), undefined)
  assert.deepEqual(d.list().map(s => s.appId), ['gimp', 'geany'])
  // its display is free again
  assert.equal((await d.launch(xterm)).display, 10)
  // stop(): the app, the window manager and the display; a process that ignores SIGTERM gets SIGKILL
  const gx = f.of(11, 'Xvnc'), gapp = f.of(11, 'dbus-run-session')
  gapp.stubborn = true
  assert.equal(d.stop(b.id), true)
  assert.deepEqual(gx.signals, ['SIGTERM'])
  await until(() => gapp.signals.includes('SIGKILL'), 'SIGKILL after the grace')
  assert.equal(d.stop(b.id), false, 'already gone')
  // the display dying ends the session too
  const cx = f.of(13, 'Xvnc'), capp = f.of(13, 'dbus-run-session')
  cx.exit(1)
  assert.deepEqual(capp.signals, ['SIGTERM'])
  assert.ok(!d.list().some(s => s.appId === 'geany'))
  // a display that does not come up: the error said, nothing left running
  const f2 = fakeSpawner()
  const d2 = createDisplays({ spawn: f2.spawn, ready: async () => { throw new Error('no display server on port 5910') }, taken: () => false, has: () => false, env: { PATH: '' }, stopGraceMs: 10 })
  await assert.rejects(d2.launch(xterm), e => e.code === 'displayFailed')
  assert.equal(f2.calls.length, 1); assert.deepEqual(f2.calls[0].signals, ['SIGTERM'])
  assert.deepEqual(d2.list(), [])
  // no dbus-run-session: the app itself
  const d3 = createDisplays({ spawn: f2.spawn, ready: async () => {}, taken: () => false, has: () => false, env: { PATH: '' } })
  await d3.launch(xterm)
  assert.equal(f2.calls.at(-1).cmd, 'xterm')
  await assert.rejects(d3.launch(CATALOG.find(a => a.kind === 'cli')), e => e.code === 'notGui')
  // all displays taken
  const d4 = createDisplays({ spawn: f2.spawn, ready: async () => {}, taken: () => true, has: () => false, env: { PATH: '' } })
  await assert.rejects(d4.launch(xterm), e => e.code === 'noDisplay')
  d.stopAll(); d3.stopAll()
  assert.deepEqual(d.list(), [])
}

// ── installing, through a fake nookbox window; the routes ──
{
  // dpkg-query by itself: installed only when "ii", an :arch suffix dropped; no dpkg at all → null
  const fakeExec = out => (_c, _a, _o, cb) => setImmediate(() => cb(out.err || null, out.stdout || '', ''))
  assert.deepEqual(await installedOf(['jq', 'gimp', 'xterm'], { execFile: fakeExec({ stdout: 'jq\tii \ngimp:arm64\tii \nxterm\trc \n' }) }), { jq: true, gimp: true, xterm: false })
  assert.equal(await installedOf(['jq'], { execFile: fakeExec({ err: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }), null)
  assert.deepEqual(await installedOf(['nope'], { execFile: fakeExec({ err: Object.assign(new Error('x'), { code: 1 }), stdout: '' }) }), { nope: false })
}
{
  const nb = { selfInstall: true, asked: [], removed: [], given: new Set(['xterm', 'mousepad']), hold: null, answer: { status: 200, body: { ok: true, code: 0, output: 'Setting up jq (1.7.1-6) ...' } } }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    for await (const c of req) body += c
    const send = (code, v) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)) }
    if (req.method === 'GET' && url.pathname === '/v1/box') return send(200, { box: { name: 'ruyix-test', spec: { self_install: nb.selfInstall } } })
    if (req.method === 'POST' && url.pathname === '/v1/packages') {
      nb.asked.push(JSON.parse(body).packages)
      if (nb.hold) await nb.hold
      if (!nb.selfInstall) return send(403, { error: 'this box may not install packages itself: on the host, `nookbox update ruyix-test --self-install true`' })
      return send(nb.answer.status, nb.answer.body)
    }
    // nookbox 0.5.11: only what it installed comes out again (the image's own: 400)
    if (req.method === 'POST' && url.pathname === '/v1/packages/remove') {
      const names = JSON.parse(body).packages
      nb.removed.push(names)
      if (!nb.selfInstall) return send(403, { error: 'this box may not change its packages itself' })
      if (names.some(n => !nb.given.has(n))) return send(400, { error: `not installed into this box by nookbox (part of its image, or never installed): ${names.filter(n => !nb.given.has(n)).join(' ')}` })
      for (const n of names) { nb.given.delete(n); installed.delete(n) }
      return send(200, { ok: true, code: 0, output: `Removing ${names.join(' ')} ...` })
    }
    send(404, { error: 'not found' })
  })
  const API = `http://127.0.0.1:${await listen(server)}`
  // the box: dpkg says what is installed; PATH has the display's programs (empty files, executable)
  const installed = new Set(['xterm', ...GUI_SUPPORT])
  const execFile = (_c, args, _o, cb) => setImmediate(() => cb(null, args.slice(2).filter(n => installed.has(n)).map(n => `${n}\tii \n`).join(''), ''))
  const bin = mkdtempSync(join(tmpdir(), 'ruyix-apps-bin-'))
  for (const c of ['Xvnc', 'matchbox-window-manager']) { writeFileSync(join(bin, c), '#!/bin/sh\n'); chmodSync(join(bin, c), 0o755) }
  function fakeDsh({ env, displays, windows }) {
    let handler, part = null
    const upgrades = []
    const effects = []
    const ctx = {
      connection: { fetch: { register: h => { handler = h } } }, logger: { info() {} },
      effect: f => effects.push(f),
      inject: (names, f) => {
        if (names.includes('ruyixShell')) f({ ruyixShell: { part: p => { part = p; return () => {} } }, effect: g => g() })
        if (names.includes('webServer')) f({ connection: { admit: () => ({}) }, webServer: { registerUpgrade: r => { upgrades.push(r); return () => {} } }, effect: g => g() })
      },
    }
    // (no Playwright Chromium, whatever this machine has; the agents' browser's socket in a home of its own)
    apply(ctx, {}, { env: { PLAYWRIGHT_BROWSERS_PATH: '/nonexistent', RUYIX_HOME: mkdtempSync(join(tmpdir(), 'apps-home-')), ...env }, displays, execFile, ...(windows && { windows }) })
    const call = async (op, args = {}) => {
      const res = await handler.fetch(new Request('http://dsh/api/ruyix-apps', { method: 'POST', body: JSON.stringify({ op, ...args }) }))
      return { status: res.status, body: await res.json() }
    }
    return { call, part: () => part, upgrades: () => upgrades, dispose: () => effects.forEach(f => f()?.()) }
  }
  const launched = []
  const displays = { launch: async a => { launched.push(a.id); return { id: 's1', appId: a.id, display: 10, state: 'running' } }, list: () => launched.map(id => ({ id: 's1', appId: id })), stop: id => id === 's1', stopAll() { launched.length = 0 }, get: () => undefined }
  const env = { NOOKBOX_API: API, PATH: bin }
  const dsh = fakeDsh({ env, displays })
  // the folders a file manager has open (one per window, its title read as the folder) and one brought forward
  {
    const fm = [{ id: 'f1', appId: 'thunar', display: 12, state: 'running' }, { id: 'x1', appId: 'xterm', display: 13, state: 'running' }]
    const shown = []
    const windows = { list: async d => (d === 12 ? [{ id: 7, name: 'docs - Thunar' }, { id: 8, name: '' }, { id: 9, name: '下载 - File Manager' }] : [{ id: 1, name: 'xterm' }]), activate: async (d, w) => { shown.push([d, w]); return w === 9 } }
    const fd = fakeDsh({ env, displays: { ...displays, list: () => fm, get: id => fm.find(x => x.id === id) }, windows })
    assert.deepEqual((await fd.call('fileWindows')).body.windows, [{ appId: 'thunar', session: 'f1', win: 7, folder: 'docs' }, { appId: 'thunar', session: 'f1', win: 9, folder: '下载' }], 'file managers only; a window with no title left out')
    assert.deepEqual([(await fd.call('fileWindowFocus', { session: 'f1', win: 9 })).body, shown], [{ ok: true }, [[12, 9]]])
    assert.equal((await fd.call('fileWindowFocus', { session: 'x1', win: 1 })).body.error, 'noWindow', 'not a file manager\'s')
    assert.deepEqual(['a - Thunar', 'GNOME — Files', 'plain', ' - Thunar'].map(folderOf), ['a', 'GNOME', 'plain', ''])
    // the helper: what xwin.py prints, read; a window not there: false
    const xe = (_c, args, o, cb) => setImmediate(() => (args[2] === 'list' ? cb(null, JSON.stringify([{ id: 5, name: 'docs - Thunar' }, { id: 'x' }]), '') : cb(args[3] === '5' && o.env.DISPLAY === ':12' ? null : new Error('exit 1'), '', '')))
    const xw = createWindows({ env: {}, execFile: xe })
    assert.deepEqual(await xw.list(12), [{ id: 5, name: 'docs - Thunar' }])
    assert.deepEqual([await xw.activate(12, 5), await xw.activate(12, 6), await xw.activate(12, -1)], [true, false, false])
    fd.dispose()
  }
  assert.deepEqual(dsh.upgrades().map(u => u.path), ['/ruyix-apps/vnc', '/ruyix-apps/term'])
  assert.equal(dsh.part().id, 'apps'); assert.equal(dsh.part().order, 41)

  const cat = (await dsh.call('catalog')).body
  assert.equal(cat.apps.length, CATALOG.length); assert.deepEqual(cat.support, GUI_SUPPORT)
  let st = (await dsh.call('state')).body
  assert.equal(st.inBox, true); assert.equal(st.box, 'ruyix-test'); assert.equal(st.canInstall, true); assert.equal(st.dpkg, true)
  assert.equal(st.installed.xterm, true); assert.equal(st.installed.jq, false); assert.equal(st.support.ready, true)

  // install an app: a job, polled until done; one apt run at a time, the next waits
  let release
  nb.hold = new Promise(r => { release = r })
  const j1 = (await dsh.call('install', { appId: 'jq' })).body.job
  const j2 = (await dsh.call('install', { packages: ['htop', 'tree'] })).body.job
  assert.equal(j1.packages.join(), 'jq'); assert.equal(j2.state, 'queued')
  assert.equal((await dsh.call('install', { appId: 'jq' })).body.job.id, j1.id, 'the same install asked twice: one job')
  await until(() => nb.asked.length === 1, 'the first install reached nookbox')
  st = (await dsh.call('state')).body
  assert.equal(st.installing.id, j1.id)
  assert.deepEqual(dsh.part().busy(), ['install jq: running', 'install htop tree: queued'], 'a restart would cut these short')
  assert.equal(nb.asked.length, 1, 'the second waits')
  nb.hold = null; release()
  await until(async () => (await dsh.call('state')).body.jobs.every(j => j.state === 'done'), 'both done')
  assert.deepEqual(nb.asked, [['jq'], ['htop', 'tree']])
  st = (await dsh.call('state')).body
  assert.match(st.jobs[0].output, /Setting up jq/); assert.equal(st.installing, null); assert.deepEqual(dsh.part().busy(), [])
  // apt failing: the job fails with its output
  nb.answer = { status: 200, body: { ok: false, code: 100, output: 'E: Unable to locate package nosuchthing' } }
  const j3 = (await dsh.call('install', { packages: ['nosuchthing'] })).body.job
  await until(async () => (await dsh.call('state')).body.jobs.find(j => j.id === j3.id).state === 'failed', 'apt failed')
  const f3 = (await dsh.call('state')).body.jobs.find(j => j.id === j3.id)
  assert.equal(f3.code, 'aptFailed'); assert.match(f3.output, /Unable to locate/)
  // the box's spec does not allow it (403): the host command to allow it, with the box's name
  nb.selfInstall = false
  const j4 = (await dsh.call('install', { appId: 'ripgrep' })).body.job
  await until(async () => (await dsh.call('state')).body.jobs.find(j => j.id === j4.id).state === 'failed', '403')
  const f4 = (await dsh.call('state')).body.jobs.find(j => j.id === j4.id)
  assert.equal(f4.code, 'notAllowed')
  assert.equal(f4.params.allow, 'nookbox update ruyix-test --self-install true')
  assert.equal(f4.params.install, 'nookbox install ruyix-test ripgrep')
  // bad input
  let r = await dsh.call('install', { packages: ['ok', 'Bad;rm'] })
  assert.equal(r.status, 400); assert.equal(r.body.error, 'badPackage'); assert.equal(r.body.params.name, 'Bad;rm'); assert.ok(r.body.params.message)
  assert.equal((await dsh.call('install', { appId: 'nope' })).body.error, 'noApp')
  assert.equal((await dsh.call('nope')).body.error, 'unknownOp')
  // the display's packages
  nb.selfInstall = true; nb.answer = { status: 200, body: { ok: true, code: 0, output: '' } }
  assert.deepEqual((await dsh.call('install', { support: true })).body.job.packages, GUI_SUPPORT)

  // uninstall: an app the box installed comes out (a job like an install); the image's own, one not installed, or one whose
  // packages other installed apps use, stay; its window closes first
  installed.add('mousepad')
  assert.equal((await dsh.call('uninstall', { appId: 'zellij' })).body.error, 'fromImage')
  assert.equal((await dsh.call('uninstall', { appId: 'gimp' })).body.error, 'notInstalled')
  const ju = (await dsh.call('uninstall', { appId: 'mousepad' })).body.job
  assert.equal(ju.remove, true); assert.deepEqual(ju.packages, ['mousepad'])
  await until(async () => (await dsh.call('state')).body.jobs.find(j => j.id === ju.id).state === 'done', 'uninstalled')
  st = (await dsh.call('state')).body
  assert.equal(st.installed.mousepad, false, 'gone: dpkg says so'); assert.deepEqual(nb.removed.at(-1), ['mousepad'])
  // nookbox refusing one it did not install (the image's): the job says why, in the page's words
  installed.add('geany')
  const jg = (await dsh.call('uninstall', { appId: 'geany' })).body.job
  await until(async () => (await dsh.call('state')).body.jobs.find(j => j.id === jg.id).state === 'failed', 'refused')
  assert.equal((await dsh.call('state')).body.jobs.find(j => j.id === jg.id).code, 'notRemovable')
  installed.delete('geany')
  // what an uninstall takes: its own packages, not another installed app's, never the display's
  assert.deepEqual(removable({ packages: ['a', 'b', 'tigervnc-standalone-server'] }, ['b']), ['a'])
  assert.deepEqual(removable({ packages: ['libreoffice-writer', 'libreoffice-gtk3'] }, ['libreoffice-gtk3']), ['libreoffice-writer'])

  // launch: only an installed graphical app, only with the display's programs
  assert.equal((await dsh.call('launch', { appId: 'xterm' })).body.session.id, 's1')
  assert.deepEqual(launched, ['xterm'])
  assert.equal((await dsh.call('launch', { appId: 'gimp' })).body.error, 'notInstalled')
  assert.equal((await dsh.call('launch', { appId: 'jq' })).body.error, 'notGui')
  assert.equal((await dsh.call('launch', { appId: 'terminal' })).body.error, 'isTerm')
  // a terminal: not installed here (no tmux by dpkg or on PATH), its session not there; ending one only for a terminal
  assert.equal(st.installed.terminal, false); assert.deepEqual(st.terms, { terminal: { running: false }, zellij: { running: false } })
  assert.equal((await dsh.call('end', { appId: 'terminal' })).body.ended, 'terminal')
  assert.equal((await dsh.call('end', { appId: 'xterm' })).body.error, 'noApp')
  assert.equal((await dsh.call('launch', { appId: 'zzz' })).body.error, 'noApp')
  assert.deepEqual((await dsh.call('sessions')).body.sessions.map(s => s.appId), ['xterm'])
  assert.equal((await dsh.call('stop', { id: 's1' })).body.stopped, true)
  assert.equal((await dsh.call('stop', { id: 'other' })).body.stopped, false)
  const ov = await dsh.part().overview()
  assert.equal(ov[0].tiles.find(t => t.id === 'installed').value, 1)
  // the plugin going stops every session
  dsh.dispose()
  assert.deepEqual(launched, [])

  // no display programs on PATH: said, with what to install
  const noX = fakeDsh({ env: { NOOKBOX_API: API, PATH: '' }, displays })
  r = await noX.call('launch', { appId: 'xterm' })
  assert.equal(r.body.error, 'noDisplayServer'); assert.match(r.body.params.packages, /tigervnc-standalone-server/)
  // the box's spec read: not allowed → canInstall false
  nb.selfInstall = false
  assert.equal((await noX.call('state')).body.canInstall, false)

  // not in a box: nothing installs, the page is told so
  const out = fakeDsh({ env: { PATH: '' }, displays })
  st = (await out.call('state')).body
  assert.equal(st.inBox, false); assert.equal(st.canInstall, false)
  r = await out.call('install', { appId: 'jq' })
  assert.equal(r.status, 400); assert.equal(r.body.error, 'notInBox'); assert.equal(r.body.params.install, 'sudo apt install jq')
  // a box window that does not answer: the job fails, said plainly
  const dead = fakeDsh({ env: { NOOKBOX_API: 'http://127.0.0.1:9', PATH: '' }, displays })
  const j5 = (await dead.call('install', { appId: 'jq' })).body.job
  await until(async () => (await dead.call('state')).body.jobs.find(j => j.id === j5.id).state === 'failed', 'no nookbox')
  assert.equal((await dead.call('state')).body.jobs[0].code, 'notInBox')
  server.close()
}

// ── terminals: the look, tmux's and zellij's settings, the messages; a real pseudo-terminal end to end ──
{
  assert.deepEqual(lookOf({ tone: 'dark' }), LOOK.dark)
  const look = lookOf({ tone: 'light', bg: '#FFFFFF', accent: '#b45309', fg: 'red;rm', line: '#12345' })
  assert.equal(look.bg, '#ffffff'); assert.equal(look.accent, '#b45309')
  assert.equal(look.fg, LOOK.light.fg, 'not a colour: Ruyix\'s own'); assert.equal(look.line, LOOK.light.line)
  const conf = tmuxConf(look)
  assert.match(conf, /pane-active-border-style "fg=#b45309"/); assert.match(conf, /window-status-current-format "#\[fg=#ffffff,bg=#b45309,bold\]/)
  assert.match(conf, /set -g mouse on/)
  assert.doesNotMatch(conf, /set -a|set -as/, 'read again at each opening: nothing appends')
  assert.deepEqual(conf.trim().split('\n').slice(-2), ['if-shell "test -f ~/.tmux.conf" "source-file ~/.tmux.conf"', 'if-shell "test -f ~/.config/tmux/tmux.conf" "source-file ~/.config/tmux/tmux.conf"'], 'the person\'s own settings last')
  // (a conditional's commas are escaped in tmux's formats)
  assert.match(conf, /#\{\?client_prefix,#\[fg=#ffffff#,bg=#b45309#,bold\] PREFIX #\[default\] ,\}/)
  const theme = zellijTheme('ruyix-light', look, { black: '#000000', red: '#ff0000', green: '#00ff00', yellow: '#ffff00', blue: '#0000ff', magenta: '#ff00ff', cyan: '#00ffff', white: '#eeeeee' })
  assert.match(theme, /^themes \{\n {2}ruyix-light \{\n/)
  // the selected tab: the window's ground on the accent; the focused pane's frame in the accent; colours as "r g b"
  assert.match(theme, /ribbon_selected \{\n {6}base 255 255 255\n {6}background 180 83 9\n/)
  assert.match(theme, /frame_selected \{\n {6}base 180 83 9\n/)
  assert.match(theme, /exit_code_error \{\n {6}base 255 0 0\n/); assert.match(theme, /player_10 238 238 238\n/)
  assert.doesNotMatch(theme, /#|NaN|undefined/)
  assert.deepEqual(parseSize('120 40'), { cols: 120, rows: 40 })
  assert.deepEqual(parseSize('0 0'), { cols: 2, rows: 1 }); assert.deepEqual(parseSize('9999 9999'), { cols: 1000, rows: 1000 })
  for (const bad of ['', '120x40', '-1 5', '12 34 56', '1e3 4']) assert.equal(parseSize(bad), null, bad)
  assert.deepEqual(parseMessage(Buffer.from([1, 0x41])), { kind: 1, body: Buffer.from('A') }); assert.equal(parseMessage(Buffer.alloc(0)), null)
  const te = termEnv({ PATH: '/bin', TMUX: '/tmp/x,1,0', ZELLIJ: '0', DSH_TOKEN: 'secret', LANG: 'zh_CN.UTF-8' }, LOOK.dark)
  assert.equal(te.TERM, 'xterm-256color'); assert.equal(te.COLORTERM, 'truecolor'); assert.equal(te.LANG, 'zh_CN.UTF-8'); assert.equal(te.COLORFGBG, '15;0')
  assert.ok(!('TMUX' in te) && !('ZELLIJ' in te) && !('DSH_TOKEN' in te), 'not inside another multiplexer; no dsh token')
}
// the multiplexers' commands, with a stand-in for running them: Ruyix's own tmux server; a look applied to a running
// server only when it changed and the person has no tmux.conf; ending only a session that is there, a failure said
{
  const home = mkdtempSync(join(tmpdir(), 'ruyix-mux-')), dir = mkdtempSync(join(tmpdir(), 'ruyix-mux-dir-'))
  const calls = [], state = { running: true, fail: false, zellijList: 'other\nmain\n' }
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '))
    if (args.includes('has-session')) { if (!state.running) throw new Error('no session'); return '' }
    if (args.includes('list-sessions')) return state.zellijList
    if (state.fail && (args.includes('kill-session') || args.includes('delete-session'))) throw new Error('refused')
    return ''
  }
  const m = muxes({ env: {}, home, run })
  const args = await m.tmux.prepare(LOOK.light, dir)
  assert.deepEqual(args.slice(0, 2), TMUX_SOCKET); assert.deepEqual(args.slice(-4), ['new-session', '-A', '-s', 'main'])
  assert.deepEqual(TMUX_SOCKET, ['-L', 'ruyix'])
  assert.ok(calls.every(c => c.startsWith('tmux -L ruyix ')), 'only Ruyix\'s own server')
  const sourced = () => calls.filter(c => c.includes('source-file')).length
  assert.equal(sourced(), 1, 'a new look: applied')
  await m.tmux.prepare(LOOK.light, dir)
  assert.equal(sourced(), 1, 'the same look: not read again')
  writeFileSync(join(home, '.tmux.conf'), 'set -ga terminal-overrides ",x:Tc"\n')
  await m.tmux.prepare(LOOK.dark, dir)
  assert.equal(sourced(), 1, 'the person\'s own tmux.conf: never read again by Ruyix')
  await m.tmux.end(); assert.ok(calls.at(-1).endsWith('kill-session -t =main'))
  state.running = false; calls.length = 0
  await m.tmux.end(); assert.ok(!calls.some(c => c.includes('kill-session')), 'no session: nothing to end')
  state.running = true; state.fail = true
  await assert.rejects(m.tmux.end(), /refused/, 'a failed end is said')
  const z = await m.zellij.prepare(LOOK.dark, dir)
  assert.deepEqual(z.slice(0, 2), ['--config', join(dir, 'zellij.kdl')])
  assert.ok(z.join(' ').includes('options --on-force-close detach'), 'closing the window only detaches')
  assert.match(readFileSync(join(dir, 'zellij.kdl'), 'utf8'), /^theme "ruyix-dark"$/m)
  mkdirSync(join(home, '.config', 'zellij'), { recursive: true }); writeFileSync(join(home, '.config', 'zellij', 'config.kdl'), '')
  assert.equal((await m.zellij.prepare(LOOK.dark, dir))[0], 'attach', 'their own zellij settings: no --config of Ruyix\'s')
  assert.equal(await m.zellij.running(), true); state.zellijList = 'other\n'; assert.equal(await m.zellij.running(), false)
  // another session, at one of its windows (an agent session's mirror): tmux attaches there and goes to that window;
  // zellij brings the tab forward and attaches without making a session
  const at = await m.tmux.prepare(LOOK.light, dir, { session: 'ruyix-agents', window: 2 })
  assert.deepEqual(at.slice(-8), ['new-session', '-A', '-s', 'ruyix-agents', ';', 'select-window', '-t', '=ruyix-agents:2'])
  calls.length = 0
  const za = await m.zellij.prepare(LOOK.dark, dir, { session: 'ruyix-agents', window: 1 })
  assert.deepEqual([calls.includes('zellij --session ruyix-agents action go-to-tab 2'), za.slice(0, 2)], [true, ['attach', 'ruyix-agents']], 'its tab forward; attached, not created')
  // every session and its windows / tabs
  const listing = async (cmd, args) => (args.includes('list-sessions') ? (cmd === 'tmux' ? 'main\nruyix-agents\n' : 'main\n') : args.includes('list-windows') ? (args.includes('=ruyix-agents') ? '0 写稿·aaaaa\n1 复查·bbbbb\n' : '0 zsh\n') : args.includes('query-tab-names') ? 'Tab #1\n' : '')
  const m2 = muxes({ env: {}, home, run: listing })
  assert.deepEqual(await m2.tmux.sessions(), [{ session: 'main', windows: [{ index: 0, name: 'zsh' }] }, { session: 'ruyix-agents', windows: [{ index: 0, name: '写稿·aaaaa' }, { index: 1, name: '复查·bbbbb' }] }])
  assert.deepEqual(await m2.zellij.sessions(), [{ session: 'main', windows: [{ index: 0, name: 'Tab #1' }] }])
  rmSync(home, { recursive: true, force: true }); rmSync(dir, { recursive: true, force: true })
}
// end to end: a page's WebSocket → the route → pty.py running a stand-in multiplexer (sh): its size, keys, a resize,
// its exit status; and the page going away hangs the terminal up (what makes tmux or zellij detach). Not on Windows
// (Python has no pty there); needs python3.
if (process.platform !== 'win32' && onPathCheck('python3')) {
  const dir = mkdtempSync(join(tmpdir(), 'ruyix-term-'))
  const hup = join(dir, 'hup')
  const script = {
    // prints its size, waits for a line, prints it and its size again (after the resize), exits 3
    talk: 'stty size; printf "ready\\n"; IFS= read -r line; printf "got:%s\\n" "$line"; stty size; exit 3',
    // a long-running one: a hang-up is written down
    hang: `trap 'echo hup > "${hup}"; exit 0' HUP; printf "ready\\n"; while :; do sleep 0.05; done`,
  }
  let which = 'talk'
  const fake = { bin: 'sh', prepare: async () => ['-c', script[which]], running: async () => which === 'hang', end: async () => {} }
  const terms = createTerms({ env: { ...process.env, HOME: dir }, mux: { tmux: fake, zellij: fake } })
  const termApp = CATALOG.find(x => x.kind === 'term')
  for (const bad of [{ session: 'a b' }, { session: '../x' }, { session: 'ok', window: '1;rm' }]) await assert.rejects(terms.open(termApp, {}, bad), /no such session/, JSON.stringify(bad))
  const open = new Set()
  const web = createServer((_q, s) => s.end())
  web.on('upgrade', termUpgrade({ terms, admit: () => ({ ok: true }), open, pingMs: 0 }))
  const port = await listen(web)
  const dial = async path => {
    const s = connect({ port, host: '127.0.0.1' })
    await new Promise(r => s.once('connect', r))
    s.write([`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'))
    let raw = Buffer.alloc(0), head = null
    const frames = [], read = frameReader({ requireMask: false }), st = { ended: false }
    s.on('data', d => {
      if (head === null) { raw = Buffer.concat([raw, d]); const at = raw.indexOf('\r\n\r\n'); if (at < 0) return; head = raw.subarray(0, at).toString(); d = raw.subarray(at + 4) }
      if (d.length) frames.push(...read(d))
    })
    s.on('close', () => { st.ended = true })
    await until(() => head !== null || st.ended, 'an HTTP answer')
    const msg = (kind, text) => s.write(encodeFrame(OP.BINARY, Buffer.concat([Buffer.from([kind]), Buffer.from(text)]), { mask: Buffer.from([3, 1, 4, 1]) }))
    const shown = () => Buffer.concat(frames.filter(f => f.opcode === OP.BINARY && f.payload[0] === MSG.DATA).map(f => f.payload.subarray(1))).toString()
    return { s, head: head || '', frames, st, msg, shown }
  }
  const c = await dial('/ruyix-apps/term?app=terminal&cols=90&rows=25&tone=dark')
  assert.match(c.head, /^HTTP\/1\.1 101 /)
  await until(() => c.shown().includes('ready'), 'the program started', 8000)
  assert.match(c.shown(), /^25 90\r?$/m, 'started at the page\'s size')
  c.msg(MSG.CONTROL, '120 40')
  await sleep(150)
  c.msg(MSG.DATA, '你好 hello\r')
  await until(() => c.st.ended, 'the program exited', 8000)
  assert.match(c.shown(), /got:你好 hello/, 'keys reach it as UTF-8')
  assert.match(c.shown(), /^40 120\r?$/m, 'the resize reached it')
  const end = c.frames.find(f => f.opcode === OP.BINARY && f.payload[0] === MSG.CONTROL)
  assert.deepEqual(JSON.parse(end.payload.subarray(1).toString()), { exit: 3 }, 'its exit status, then the close')
  assert.equal(c.frames.find(f => f.opcode === OP.CLOSE).payload.readUInt16BE(0), 1000)
  // keys sent before the program runs are kept for it
  which = 'talk'
  const early = await dial('/ruyix-apps/term?app=zellij&cols=80&rows=24')
  early.msg(MSG.CONTROL, '77 33')
  early.msg(MSG.DATA, 'early\r')
  await until(() => early.st.ended, 'the early one exited', 8000)
  assert.match(early.shown(), /got:early/)
  assert.match(early.shown(), /got:early\r?\n33 77/, 'a resize sent before the program ran is not undone by the start\'s size')
  // the page going away: the terminal is hung up (a multiplexer detaches then), and nothing is left running
  which = 'hang'
  const h = await dial('/ruyix-apps/term?app=terminal')
  await until(() => h.shown().includes('ready'), 'the long one started', 8000)
  assert.equal(terms.viewing, 1)
  h.s.destroy()
  await until(() => existsSync(hup), 'SIGHUP reached the program', 8000)
  await until(() => terms.viewing === 0 && open.size === 0, 'the view forgotten', 8000)
  // not a terminal app, no such app, a multiplexer that is not here: 404; not signed in: dsh's refusal
  assert.match((await dial('/ruyix-apps/term?app=xterm')).head, /^HTTP\/1\.1 404 /)
  assert.match((await dial('/ruyix-apps/term?app=nope')).head, /^HTTP\/1\.1 404 /)
  const none = createTerms({ env: { PATH: '' } })
  assert.equal(none.available(CATALOG.find(a => a.id === 'terminal')), false)
  // not signed in: dsh's refusal; an answer of a shape this code does not know: refused too (a shell is behind it)
  const refusedBy = async admit => {
    const w = createServer((_q, s) => s.end())
    w.on('upgrade', termUpgrade({ terms, admit, pingMs: 0 }))
    const p = await listen(w)
    const answer = await new Promise(resolve => {
      const s = connect({ port: p, host: '127.0.0.1' }, () => s.write(`GET /ruyix-apps/term?app=terminal HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`))
      s.on('data', d => { resolve(d.toString()); s.destroy() })
    })
    w.close()
    return answer
  }
  assert.match(await refusedBy(() => ({ rejection: 401 })), /^HTTP\/1\.1 401 /)
  assert.match(await refusedBy(() => undefined), /^HTTP\/1\.1 403 /)
  assert.match(await refusedBy(() => 'yes'), /^HTTP\/1\.1 403 /)
  web.close()
  rmSync(dir, { recursive: true, force: true })
} else console.log('terminal end to end: skipped (no pty here)')
function onPathCheck(cmd) { return String(process.env.PATH || '').split(delimiter).some(d => existsSync(join(d, cmd))) }

// ── text typed into an app: keysyms; which key presses are text for the input box ──
{
  assert.equal(keysymOf('a'), 0x61)
  assert.equal(keysymOf('é'), 0xe9, 'Latin-1 keeps its own code')
  assert.equal(keysymOf('中'), 0x01004e2d, 'the rest are Unicode keysyms')
  assert.equal(keysymOf('😀'), 0x0101f600, 'beyond the BMP too')
  assert.equal(keysymOf('\u0007'), 0, 'control characters are not typed')
  assert.deepEqual(keysymsOf('你好\r\n,\t'), [0x01004f60, 0x0100597d, XK_RETURN, 0x2c, XK_TAB], 'CRLF is one Return')
  assert.deepEqual(keysymsOf(''), [])
  const cjk = n => Array.from({ length: n }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('')
  assert.equal(viaClipboard(keysymsOf(cjk(SPARE))), false, 'a few new characters are typed')
  assert.equal(viaClipboard(keysymsOf(cjk(SPARE + 1))), true, 'more than Xvnc can lend at once go by clipboard')
  assert.equal(viaClipboard(keysymsOf(cjk(SPARE).repeat(20))), false, 'repeats count once')
  assert.equal(viaClipboard(keysymsOf('x'.repeat(5000) + '\n\t')), false, 'ASCII, Return and Tab are on the keyboard')
  const named = k => ['Enter', 'ArrowLeft', 'Backspace', 'Shift', 'Meta', 'Unidentified', 'Process', 'Dead'].includes(k)
  const key = (k, mods = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods })
  assert.equal(isTextKey(key('a'), named), false, 'a plain ASCII key is noVNC\'s')
  assert.equal(isTextKey(key('Enter'), named), false)
  assert.equal(isTextKey(key('Hello'), named), true, 'several characters at once (dictation typing) — even ones that look like a key name')
  assert.equal(isTextKey(key('中'), named), true)
  assert.equal(isTextKey(key('ü'), named), true, 'a non-ASCII key: its character, not its place')
  assert.equal(isTextKey(key('😀'), named), true)
  assert.equal(isTextKey(key('中', { metaKey: true }), named), false, 'a shortcut stays noVNC\'s')
  assert.equal(isTextKey(key('å', { altKey: true }), named), false)
  assert.equal(isTextKey(key(''), named), false)
}

// ── the agents' browser's Chromium: Playwright's, in a folder per version and platform (a box on an Apple chip: linux-arm64) ──
{
  const { chromiumPath } = await import('./lib/browser.js')
  const cache = mkdtempSync(join(tmpdir(), 'pw-'))
  for (const [ver, sub] of [['chromium-1200', 'chrome-linux64'], ['chromium-1248', 'chrome-linux-arm64'], ['chromium_headless_shell-1248', 'chrome-linux-arm64']]) {
    mkdirSync(join(cache, ver, sub), { recursive: true }); writeFileSync(join(cache, ver, sub, 'chrome'), '')
  }
  assert.equal(chromiumPath({ env: {}, cache }), join(cache, 'chromium-1248', 'chrome-linux-arm64', 'chrome'), 'the newest, whatever its platform folder; not the headless shell')
  assert.equal(chromiumPath({ env: {}, cache: join(cache, 'none') }), null)
}

// ── the page's words and look ──
assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), 'zh and en have the same keys')
// every coded error the host raises is worded
const host = ['index.js', 'lib/install.js', 'lib/display.js', 'lib/catalog.js'].map(f => readFileSync(f, 'utf8')).join('\n')
const codes = new Set([...host.matchAll(/coded\('([a-zA-Z]+)'|code: '([a-zA-Z]+)'|error: '([a-zA-Z]+)'/g)].map(m => m[1] || m[2] || m[3]))
for (const c of codes) assert.ok(zh[`err.${c}`] && en[`err.${c}`], `err.${c} is worded`)
assert.ok(codes.has('notAllowed') && codes.has('noDisplayServer'), 'the codes were found')
// the tokens: only --ruyix-* (no dsh alias), each defined in the shell's tokens.css
{
  const tokens = readFileSync('../../shell/tokens.css', 'utf8')
  const defined = new Set([...tokens.matchAll(/(--ruyix-[a-z0-9-]+):/g)].map(m => m[1]))
  const src = readdirSync('src').filter(f => /\.(css|jsx?)$/.test(f)).map(f => readFileSync(join('src', f), 'utf8')).join('\n')
  assert.doesNotMatch(src, /--dsw-alias-/, 'style with the --ruyix-* tokens')
  const unknown = [...new Set([...src.matchAll(/var\((--ruyix-[a-z0-9-]+)/g)].map(m => m[1]))].filter(t => !defined.has(t))
  assert.deepEqual(unknown, [], 'every --ruyix-* in use is defined in tokens.css')
}
const client = existsSync(new URL('./client.js', import.meta.url)) && readFileSync(new URL('./client.js', import.meta.url), 'utf8')
assert.ok(client && client.includes("id: '@ruyix/apps'"), 'client.js is built (node build.mjs)')
assert.ok(!/await _checkWebCodecsH264DecodeSupport\(\)/.test(client), 'noVNC\'s top-level await is gone from the bundle')

// the desk widget's short names: no two windowed apps alike (four terminals were all 终端)
{
  const src = readFileSync('src/main.jsx', 'utf8')
  assert.match(src, /const short = shortName\(lang\)/)
  for (const lang of ['zh', 'en']) {
    const full = a => a.name[lang] || a.name.en
    const before = a => full(a).split(/[（(]/)[0].trim(), inside = a => (/[（(]([^）)]+)[）)]/.exec(full(a)) || [])[1]?.trim()
    const win = CATALOG.filter(a => a.kind === 'gui' || a.kind === 'term'), seen = {}
    for (const a of win) seen[before(a)] = (seen[before(a)] || 0) + 1
    const names = win.map(a => (seen[before(a)] > 1 && inside(a)) || before(a))
    assert.equal(new Set(names).size, names.length, `${lang}: ${names.join(', ')}`)
    if (lang === 'zh') assert.deepEqual(names.slice(0, 4), ['终端', 'Zellij', 'GNOME 控制台', '文件'])
  }
}
// the main agent's tools (the shell's system tools): an app by its id or name; installing; opening and closing its window on the page
{
  assert.equal(appBy('gimp').id, 'gimp'); assert.equal(appBy('终端（Zellij）').id, 'zellij'); assert.equal(appBy('Terminal').id, 'terminal'); assert.equal(appBy('nope'), null)
  const installs = [], asked = []
  const installed = { gimp: true, terminal: true }
  const removals = []
  const ops = { install: a => { installs.push(a); return { job: { id: 'j1', state: 'queued', packages: a.packages || ['gimp'] } } }, uninstall: async a => { removals.push(a); return { job: { id: 'j2', state: 'queued', remove: true, packages: ['gimp'] } } } }
  const state = async () => ({ inBox: true, canInstall: true, installed, sessions: [{ appId: 'gimp' }], terms: { terminal: { running: true } }, jobs: [] })
  const t = Object.fromEntries(systemTools({ ops, state, page: (e, d) => asked.push([e, d]) }).map(x => [x.name, x]))
  assert.deepEqual(Object.values(t).map(x => [x.name, x.effect]), [['apps_list', 'read'], ['apps_install', 'direct'], ['apps_uninstall', 'direct'], ['apps_open', 'direct'], ['terminal_open', 'direct'], ['apps_close', 'undo']])
  assert.match((await t.apps_list.run({})).text, /- gimp \| Image editor \(GIMP\) · 图像处理（GIMP） \| gui \| installed \| open/)
  assert.match((await t.apps_list.run({})).text, /- terminal \| Terminal · 终端 \| term \| installed \| open/)
  const already = await t.apps_install.run({ app: 'gimp' })
  assert.match(already.text, /already installed/)
  assert.equal(already.undo, undefined, 'a no-op cannot offer to remove the pre-existing app')
  assert.deepEqual(installs, [])
  const i = await t.apps_install.run({ app: 'inkscape' })
  assert.deepEqual(installs.at(-1), { appId: 'inkscape' }); assert.deepEqual(i.undo, { tool: 'apps_uninstall', args: { app: 'inkscape' } }, 'undone by uninstalling'); assert.equal(i.summary.zh, '开始安装：矢量绘图（Inkscape）')
  // a package by any other name is the person's (App Center → Install by name): the main agent installs only the catalog's
  await assert.rejects(t.apps_install.run({ app: 'htop' }), /Install by name/); assert.equal(installs.length, 1)
  assert.deepEqual(Object.keys(t.apps_install.parameters.properties), ['app'])
  await assert.rejects(t.apps_install.run({ app: 'zellij' }), /comes with the Ruyix image/)
  const u = await t.apps_uninstall.run({ app: 'GIMP' })
  assert.deepEqual(removals.at(-1), { appId: 'gimp' }); assert.deepEqual(u.undo, { tool: 'apps_install', args: { app: 'gimp' } }); assert.equal(u.summary.zh, '开始卸载：图像处理（GIMP）')
  await assert.rejects(t.apps_uninstall.run({ app: 'nope' }), /catalog/)
  const o = await t.apps_open.run({ app: 'GIMP' })
  assert.deepEqual(asked.at(-1), ['ruyix-apps:open', { appId: 'gimp' }]); assert.deepEqual(o.undo, { tool: 'apps_close', args: { app: 'gimp' } })
  await t.apps_close.run(o.undo.args); assert.deepEqual(asked.at(-1), ['ruyix-apps:close', { appId: 'gimp' }])
  await assert.rejects(t.apps_open.run({ app: 'jq' }), /no window/)
  await assert.rejects(t.apps_open.run({ app: 'inkscape' }), /not installed/)
}
// found by what they do (the shell's find): every app, what it does to match, how to use it — installed or not
{
  const hits = await appFinder({ state: async () => ({ installed: { terminal: true, ffmpeg: true } }) }).find()
  assert.equal(hits.length, CATALOG.length)
  const by = id => hits.find(h => h.id === id)
  assert.deepEqual([by('terminal').how, by('zellij').how.startsWith('apps_install { app: "zellij" }')], ['apps_open { app: "terminal" }', true])
  assert.match(by('zellij').hint, /还没装/); assert.match(by('zellij').text, /终端 terminal/)
  assert.match(by('ffmpeg').how, /command-line tool: run ffmpeg/); assert.match(by('ffmpeg').hint, /音视频/)
  assert.equal((await appFinder({ state: async () => { throw new Error('down') } }).find()).every(h => h.how.startsWith('apps_install')), true, 'no state: nothing said installed')
}
// the person's own apps (lib/made.js): made, changed (each version kept), back a version, put aside and back; their tools
{
  const home = mkdtempSync(join(tmpdir(), 'ruyix-made-'))
  let t = 1000
  const made = createMade({ home, now: () => (t += 1000) })
  assert.equal(idOf('Pomodoro Timer!'), 'pomodoro-timer'); assert.match(idOf('番茄钟'), /^app-/)
  const a = made.make({ name: '番茄钟 Pomodoro', summary: '25 分钟一个番茄', icon: 'Timer', html: '<h1>v1</h1>', by: 'session:x' })
  assert.deepEqual([a.id, a.version, a.icon], ['pomodoro', 1, 'Timer'])
  assert.equal(made.make({ name: 'Pomodoro', summary: '', html: '<p>' }).id, 'pomodoro-2', 'a name taken: the next one')
  assert.throws(() => made.make({ name: 'x', html: ' ' }), e => e.code === 'noHtml')
  assert.throws(() => made.make({ name: 'big', html: 'x'.repeat(MAX_HTML + 1) }), e => e.code === 'tooBig')
  const e = made.edit(a.id, { html: '<h1>v2</h1>', summary: '番茄钟，带声音' })
  assert.deepEqual([e.was, e.app.version, made.get(a.id).html, made.get(a.id, { version: 1 }).html], [1, 2, '<h1>v2</h1>', '<h1>v1</h1>'])
  const back = made.restore(a.id, 1)
  assert.deepEqual([back.app.version, made.get(a.id).html, made.get(a.id).app.summary], [3, '<h1>v1</h1>', '25 分钟一个番茄'], 'back as a new version: nothing lost')
  const aside = made.remove(a.id)
  assert.throws(() => made.get(a.id), e2 => e2.code === 'noMade'); assert.ok(!made.list().some(x => x.id === a.id))
  assert.equal(made.unremove(aside).version, 3)
  assert.throws(() => made.get('../etc'), e2 => e2.code === 'noMade')
  // the tools: making it opens it; each change undoable; apps_open opens the person's own too
  const asked = [], page = (ev, d) => asked.push([ev, d.id])
  const tl = Object.fromEntries([...madeTools({ made, page }), ...appTools({ ops: {}, state: async () => ({ installed: {}, sessions: [], terms: {}, jobs: [] }), page, made })].map(x => [x.name, x]))
  const r = await tl.app_make.run({ name: 'Dice', summary: '掷骰子', html: '<button>roll</button>' }, { by: 'main' })
  assert.deepEqual([asked.at(-1), r.undo], [['ruyix-apps:made', 'dice'], { tool: 'app_drop', args: { id: 'dice', after: r.undo.args.after } }])
  const ed = await tl.app_edit.run({ id: 'dice', html: '<button>roll 2</button>' })
  assert.deepEqual(ed.undo, { tool: 'app_back', args: { id: 'dice', version: 1, after: ed.undo.args.after } })
  await tl.app_back.run(ed.undo.args); assert.equal(made.get('dice').html, '<button>roll</button>')
  const rm = await tl.app_remove.run({ id: 'dice' })
  assert.deepEqual(asked.at(-1), ['ruyix-apps:made-gone', 'dice']); await tl.app_unremove.run(rm.undo.args); assert.equal(made.get('dice').app.name, 'Dice')
  assert.match((await tl.made_list.run()).text, /^- dice \| Dice \| 掷骰子 \| v3/m)
  assert.match((await tl.app_get.run({ id: 'dice', version: 2 })).text, /roll 2/)
  const op = await tl.apps_open.run({ app: 'made:dice' })
  assert.deepEqual([asked.at(-1), op.undo], [['ruyix-apps:made', 'dice'], { tool: 'apps_close', args: { app: 'made:dice' } }])
  await assert.rejects(tl.apps_open.run({ app: 'made:nope' }), e2 => e2.code === 'noMade')
  // found among the apps, the person's own first
  const own = (await appFinder({ state: async () => ({ installed: {} }), made }).find()).filter(h => h.id.startsWith('made:'))
  assert.ok(own.some(h => h.id === 'made:dice' && /我做的/.test(h.hint) && /apps_open \{ app: "made:dice" \}/.test(h.how)))
  const stale=await tl.app_edit.run({id:'dice',html:'<p>first edit</p>'})
  await tl.app_edit.run({id:'dice',html:'<p>later work</p>'})
  await assert.rejects(tl.app_back.run(stale.undo.args),e=>e.code==='appChanged')
  await assert.rejects(tl.app_drop.run(r.undo.args),e=>e.code==='appChanged')
  assert.equal(made.get('dice').html,'<p>later work</p>')
  await assert.rejects(tl.app_back.run({id:'dice',version:1}),e=>e.code==='appChanged','legacy snapshot-less undo refuses to overwrite')
  const immediate=await tl.app_make.run({name:'Fresh',html:'<p>fresh</p>'})
  await tl.app_drop.run(immediate.undo.args);assert.ok(!made.list().some(a=>a.id==='fresh'))
  rmSync(home, { recursive: true, force: true })
}
// a terminal opened by an agent: the app's own, or one attached to a session at one of its windows; a bad name refused
{
  const asked = [], page = (ev, d) => asked.push([ev, d])
  const tt = Object.fromEntries(appTools({ ops: {}, state: async () => ({ installed: { terminal: true } }), page }).map(x => [x.name, x]))
  await tt.terminal_open.run({})
  assert.deepEqual(asked.at(-1), ['ruyix-apps:open', { appId: 'terminal' }])
  const r = await tt.terminal_open.run({ session: 'ruyix-agents', window: 2 })
  assert.deepEqual(asked.at(-1), ['ruyix-apps:term-at', { appId: 'terminal', session: 'ruyix-agents', window: 2, title: 'tmux：ruyix-agents · 2' }])
  assert.match(r.summary.zh, /开了终端：终端 · ruyix-agents/)
  await assert.rejects(tt.terminal_open.run({ session: 'a;b' }), /no such session/)
  await assert.rejects(tt.terminal_open.run({ app: 'zellij' }), /not installed/)
  await assert.rejects(tt.terminal_open.run({ app: 'xterm' }), /no terminal/)
}
// an install asked for in the conversation: a piece of that request — at work while it runs, done or failed at the end
// with a line in the person's words; outside a request (no task), nothing said
{
  const said = [], svc = { cur: 'k1', current() { return this.cur }, update: (id, patch) => said.push([id, patch]) }
  const pieces = createPieces({ tasks: () => svc })
  let n = 0
  const ops = { install: ({ appId }) => ({ job: { id: `j${++n}`, state: 'queued', packages: [appId] } }), uninstall: async ({ appId }) => ({ job: { id: `j${++n}`, state: 'queued', packages: [appId], remove: true } }) }
  const tl = Object.fromEntries(appTools({ ops, state: async () => ({ installed: {} }), page: () => {}, pieces }).map(x => [x.name, x]))
  const r = await tl.apps_install.run({ app: 'ffmpeg' })
  assert.match(r.text, /told here when it is done/)
  assert.deepEqual(said.at(-1), ['k1', { state: 'working', step: { zh: '正在安装 FFmpeg', en: 'Installing FFmpeg' } }])
  pieces.end({ id: 'j1', state: 'running' }); assert.equal(said.length, 1, 'not over yet: nothing said')
  pieces.end({ id: 'j1', state: 'done' })
  assert.deepEqual(said.at(-1), ['k1', { state: 'done', result: { zh: 'FFmpeg 装好了。', en: 'FFmpeg is installed.' } }])
  pieces.end({ id: 'j1', state: 'done' }); assert.equal(said.length, 2, 'said once')
  await tl.apps_uninstall.run({ app: 'ffmpeg' })
  pieces.end({ id: 'j2', state: 'failed', error: 'apt: locked' })
  assert.deepEqual(said.at(-1), ['k1', { state: 'failed', result: { zh: '没卸载成 FFmpeg：apt: locked', en: 'Could not uninstall FFmpeg: apt: locked' } }])
  await tl.apps_install.run({ app: 'thunar' }); pieces.end({ id: 'j3', state: 'done' })
  assert.equal(said.at(-1)[1].result.zh, '文件管理器（Thunar） 装好了。可以打开了。', 'one with a window: it can be opened')
  svc.cur = null
  const before = said.length
  assert.doesNotMatch((await tl.apps_install.run({ app: 'jq' })).text, /told here/)
  pieces.end({ id: 'j4', state: 'done' }); assert.equal(said.length, before, 'no request: nothing to tell')
  assert.equal(createPieces({ tasks: () => ({ current() { throw new Error('no scope') } }) }).now(), null)
}
console.log(`apps check: ok (${CATALOG.length} apps)`)


// A disconnected tool gives back even a handed-off turn; another live connection for that who keeps it.
{
  const { createBrowser, serveBrowser } = await import('./lib/browser.js')
  const dir = mkdtempSync(join(tmpdir(), 'rx-turn-')), sock = join(dir, 'b.sock')
  const browser = createBrowser({ home: dir, start() {}, alive: async () => true })
  const stop = serveBrowser(browser, sock), clients = []
  const peer = async () => {
    const conn = connect(sock); clients.push(conn)
    await new Promise((resolve, reject) => { conn.once('connect', resolve); conn.once('error', reject) })
    let seq = 0, buf = ''; const replies = new Map()
    conn.setEncoding('utf8'); conn.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); replies.delete(m.id) } })
    return { conn, call: (op, who) => new Promise(resolve => { const id = ++seq; replies.set(id, resolve); conn.write(JSON.stringify({ id, op, who, why: 'check this' }) + '\n') }) }
  }
  try {
    await new Promise(resolve => setTimeout(resolve, 20))
    const a = await peer(), b = await peer(), same = await peer()
    await a.call('turn', 'a'); await same.call('state', 'a')
    await a.call('handoff', 'a')
    const waiting = b.call('turn', 'b')
    a.conn.destroy(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(browser.state().holder.who, 'a', 'the other tools connection still owns the turn')
    same.conn.destroy()
    const next = await Promise.race([waiting, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('disconnected holder did not give back turn')), 1000); t.unref() })])
    assert.equal(next.holder.who, 'b')
    b.conn.destroy(); await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(browser.state().holder, null, 'a normal turn is also released on close')
  } finally { for (const c of clients) c.destroy(); stop(); browser.dispose(); rmSync(dir, { recursive: true, force: true }) }
}

// Deduplicating an installer job must retain every requesting task.
{
  const changes = [], pieces = createPieces({ tasks: () => ({ update: (id, patch) => changes.push([id, patch]) }) })
  const app = { name: { zh: '应用', en: 'App' } }, job = { id: 'shared', state: 'queued' }
  pieces.start('A', job, app); pieces.start('B', job, app); pieces.start('A', job, app)
  pieces.end({ ...job, state: 'done' })
  assert.deepEqual(changes.filter(([, p]) => p.state === 'done').map(([id]) => id), ['A', 'B'])
}

// A restart or temporarily absent task service cannot leave an install request at work forever.
{
  const home = mkdtempSync(join(tmpdir(), 'apps-pieces-')), app = { name: { zh: '应用', en: 'App' } }
  try {
    const first = createPieces({ home, tasks: () => null })
    first.start('A', { id: 'i1' }, app); first.start('B', { id: 'i1' }, app)
    let service = null; const changes = []
    const recovered = createPieces({ home, tasks: () => service })
    recovered.recover(); assert.ok(existsSync(join(home, 'apps-pending-tasks.json')))
    service = { update: (id, patch) => changes.push([id, patch]) }
    recovered.recover(); assert.deepEqual(changes.map(([id, p]) => [id, p.state]), [['A','failed'],['B','failed']])
    assert.ok(!existsSync(join(home, 'apps-pending-tasks.json')))
    const pending = createPieces({ home, tasks: () => null }); pending.start('C', {id:'i2'},app); pending.end({id:'i2',state:'done'})
    createPieces({home,tasks:()=>service}).recover(); assert.deepEqual(changes.at(-1).slice(0,1),['C']); assert.equal(changes.at(-1)[1].state,'done')
  } finally { rmSync(home,{recursive:true,force:true}) }
}

// One request may install several apps; its final result waits for all jobs and preserves any failure.
{
  const updates = [], pieces = createPieces({ tasks: () => ({ update: (_id, patch) => updates.push(patch) }) })
  const app = { name: { en: 'App', zh: '应用' } }
  pieces.start('one', {id:'a'}, app); pieces.start('one', {id:'b'}, app)
  pieces.end({id:'a',state:'failed',error:'no space'})
  assert.equal(updates.at(-1).state,'working')
  pieces.end({id:'b',state:'done'})
  assert.equal(updates.at(-1).state,'failed'); assert.match(updates.at(-1).result.en,/no space/)
}

// The terminal job outcome is durable before the task is acknowledged, so a crash cannot turn success into unknown.
{
  const home=mkdtempSync(join(tmpdir(),'apps-ack-'));let durable=false
  try {
    const pieces=createPieces({home,tasks:()=>({update:(_id,patch)=>{if(patch.state==='done') durable=JSON.parse(readFileSync(join(home,'apps-pending-tasks.json'))).some(p=>p.task==='ack'&&p.job?.state==='done')}})})
    pieces.start('ack',{id:'j'},{name:{zh:'应用',en:'App'}});pieces.end({id:'j',state:'done'})
    assert.equal(durable,true)
  } finally {rmSync(home,{recursive:true,force:true})}
}
