// Terminals drawn in the page (xterm.js), for the catalog's `term` apps: a WebSocket at /ruyix-apps/term carries one
// pseudo-terminal (termpty.py) running the app's multiplexer — tmux or zellij — attached to its session `main`. The
// multiplexer keeps the shells: the WebSocket closing (the window closed, the page reloaded, the connection dropped)
// only detaches, and opening again comes back to them; only "end the session" (stop) ends what runs there.
// Text goes over the wire, not pixels: the browser draws it (sharp, the Mac's input method and clipboard as they are).
// Messages, binary, the first byte says which: page → host 0 keys (UTF-8), 1 the size ("<cols> <rows>");
// host → page 0 what the terminal shows, 1 the end ({"exit": <status>}).
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { onPath } from './display.js'

export const TERM_PATH = '/ruyix-apps/term'
export const SESSION = 'main'
/** A session or window a window may attach to (its name as tmux and zellij take it; a window by its index). */
export const SESSION_NAME = /^[A-Za-z0-9_.-]{1,64}$/, WINDOW_INDEX = /^\d{1,4}$/
export const MSG = { DATA: 0, CONTROL: 1 }
const PTY = join(dirname(fileURLToPath(import.meta.url)), 'termpty.py')
const HEX = /^#[0-9a-f]{6}$/i

/**
 * How the terminal looks, as the page draws it now (its tokens, resolved): { tone, bg, fg, muted, line, accent } —
 * the multiplexer's bars take the same colours. Anything missing or malformed falls back to Ruyix's own.
 */
export const LOOK = {
  light: { tone: 'light', bg: '#ffffff', fg: '#344256', muted: '#53667f', line: '#dfe4eb', accent: '#0f766e' },
  dark: { tone: 'dark', bg: '#2b333f', fg: '#d9e3ef', muted: '#b7c5d8', line: '#424e5e', accent: '#5eead4' },
}
export function lookOf(q = {}) {
  const base = LOOK[q.tone === 'dark' ? 'dark' : 'light']
  const pick = k => (HEX.test(String(q[k] ?? '')) ? String(q[k]).toLowerCase() : base[k])
  return { tone: base.tone, bg: pick('bg'), fg: pick('fg'), muted: pick('muted'), line: pick('line'), accent: pick('accent') }
}

/** Ruyix's tmux settings for a look. The person's own ~/.tmux.conf (or ~/.config/tmux/tmux.conf) is read after them and wins. */
export function tmuxConf(look) {
  const { bg, fg, muted, line, accent } = look
  return [
    '# Ruyix: how a terminal in Ruyix starts tmux (the App Center writes this file at each opening — edit your own',
    '# ~/.tmux.conf instead: it is read last, so what it sets wins)',
    'set -g default-terminal "tmux-256color"',
    // (an index of its own, not -a: this file is read again at each opening)
    'set -s terminal-features[90] "xterm-256color:RGB:clipboard:hyperlinks:usstyle"',
    'set -g mouse on',
    'set -g set-clipboard on',
    'set -g history-limit 50000',
    'set -g escape-time 10',
    'set -g focus-events on',
    'set -g base-index 1',
    'setw -g pane-base-index 1',
    'set -g renumber-windows on',
    'set -g allow-rename on',
    'setw -g automatic-rename on',
    'setw -g automatic-rename-format "#{b:pane_current_path}"',
    // splits and new windows start where you are; | and - split as they look
    'bind c new-window -c "#{pane_current_path}"',
    'bind | split-window -h -c "#{pane_current_path}"',
    'bind - split-window -v -c "#{pane_current_path}"',
    'bind % split-window -h -c "#{pane_current_path}"',
    'bind \'"\' split-window -v -c "#{pane_current_path}"',
    // the look: one quiet bar at the bottom, the session on the left, the windows as tabs, the current one in the accent
    'set -g status-position bottom',
    'set -g status-justify left',
    `set -g status-style "bg=${bg},fg=${muted}"`,
    'set -g status-left-length 30',
    `set -g status-left "#[fg=${accent},bold] #S #[fg=${line}]│ "`,
    'set -g status-right-length 60',
    `set -g status-right "#{?client_prefix,#[fg=${bg}#,bg=${accent}#,bold] PREFIX #[default] ,}#[fg=${muted}]#{b:pane_current_path}  %H:%M "`,
    `setw -g window-status-format "#[fg=${muted}] #I #W "`,
    `setw -g window-status-current-format "#[fg=${bg},bg=${accent},bold] #I #W #[default]"`,
    'setw -g window-status-separator ""',
    `set -g pane-border-style "fg=${line}"`,
    `set -g pane-active-border-style "fg=${accent}"`,
    'set -g pane-border-lines single',
    `set -g message-style "bg=${accent},fg=${bg}"`,
    `set -g message-command-style "bg=${line},fg=${fg}"`,
    `setw -g mode-style "bg=${accent},fg=${bg}"`,
    `set -g display-panes-active-colour "${accent}"`,
    `set -g display-panes-colour "${muted}"`,
    `setw -g clock-mode-colour "${accent}"`,
    'if-shell "test -f ~/.tmux.conf" "source-file ~/.tmux.conf"',
    'if-shell "test -f ~/.config/tmux/tmux.conf" "source-file ~/.config/tmux/tmux.conf"',
    '',
  ].join('\n')
}

/** "#rrggbb" → "r g b", as zellij's themes write a colour. */
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(' ')
/**
 * A zellij theme for a look (zellij 0.42's components): its bars on the window's own ground, the selected tab and
 * the focused pane in the accent, the key hints in the accent. Used only when the person has no zellij settings of
 * their own (~/.config/zellij/config.kdl).
 */
export function zellijTheme(name, look, ansi) {
  const { bg, fg, muted, line, accent } = look
  const em = (e0 = accent) => [e0, ansi.green, ansi.blue, ansi.magenta]
  const part = (base, background, emphasis) => ({ base, background, emphasis })
  const parts = {
    text_unselected: part(fg, bg, em()),
    text_selected: part(fg, line, em()),
    ribbon_unselected: part(fg, line, em()),
    ribbon_selected: part(bg, accent, em(bg)),
    table_title: part(accent, bg, em()),
    table_cell_unselected: part(fg, bg, em()),
    table_cell_selected: part(bg, accent, em(bg)),
    list_unselected: part(fg, bg, em()),
    list_selected: part(bg, accent, em(bg)),
    frame_unselected: part(line, bg, em(muted)),
    frame_selected: part(accent, bg, em()),
    frame_highlight: part(ansi.yellow, bg, em(ansi.yellow)),
    exit_code_success: part(ansi.green, bg, em()),
    exit_code_error: part(ansi.red, bg, em()),
  }
  const body = Object.entries(parts).map(([k, p]) => `    ${k} {\n      base ${rgb(p.base)}\n      background ${rgb(p.background)}\n${p.emphasis.map((c, i) => `      emphasis_${i} ${rgb(c)}`).join('\n')}\n    }`)
  const players = [accent, ansi.blue, ansi.green, ansi.yellow, ansi.magenta, ansi.cyan, ansi.red, muted, fg, ansi.white]
  body.push(`    multiplayer_user_colors {\n${players.map((c, i) => `      player_${i + 1} ${rgb(c)}`).join('\n')}\n    }`)
  return `themes {\n  ${name} {\n${body.join('\n')}\n  }\n}\n`
}
/** The ANSI colours zellij's theme borrows (the page's terminal palette, src/term.jsx, has the same). */
export const ANSI = {
  light: { black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#9a6700', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781' },
  dark: { black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4' },
}

/** Ruyix's own tmux server (`tmux -L ruyix`): its settings and keys never reach a tmux the person starts elsewhere. */
export const TMUX_SOCKET = ['-L', 'ruyix']
const readIf = f => { try { return readFileSync(f, 'utf8') } catch { return null } }

/**
 * The multiplexers: how to attach (creating the session the first time), whether the session is there, how to end it.
 * `prepare(look, dir)` writes what the opening needs and returns the attach arguments.
 */
export function muxes({ env, home, run }) {
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'))
  const tmuxOwn = () => existsSync(join(home, '.tmux.conf')) || existsSync(join(config, 'tmux', 'tmux.conf'))
  const zellijOwn = () => !!env.ZELLIJ_CONFIG_FILE || existsSync(join(env.ZELLIJ_CONFIG_DIR || join(config, 'zellij'), 'config.kdl'))
  const tmux = args => run('tmux', [...TMUX_SOCKET, ...args])
  const tmuxRunning = () => tmux(['has-session', '-t', `=${SESSION}`]).then(() => true, () => false)
  const zellijRunning = async () => String(await run('zellij', ['list-sessions', '--short', '--no-formatting']).catch(() => '')).split('\n').some(l => l.trim() === SESSION)
  return {
    tmux: {
      bin: 'tmux',
      async prepare(look, dir, { session = SESSION, window = null } = {}) {
        const conf = join(dir, 'tmux.conf'), text = tmuxConf(look), before = readIf(conf)
        writeFileSync(conf, text, { mode: 0o600 })
        // a server already running read its settings when it started; a new look (the page went light or dark, another
        // accent) is applied to it — but not over the person's own tmux.conf (read after Ruyix's at the start: reading
        // it again at each opening would pile up what it appends)
        if (before !== text && !tmuxOwn()) await tmux(['source-file', conf]).catch(() => {})
        // (another session than its own — an agent session's mirror: Agent Hub's ruyix-agents — at that window)
        return [...TMUX_SOCKET, '-f', conf, 'new-session', '-A', '-s', session, ...(window != null ? [';', 'select-window', '-t', `=${session}:${window}`] : [])]
      },
      /** Its sessions on Ruyix's server, each with its windows: [{ session, windows: [{ index, name }] }] */
      async sessions() {
        const names = String(await tmux(['list-sessions', '-F', '#{session_name}']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean)
        return Promise.all(names.map(async session => ({ session, windows: String(await tmux(['list-windows', '-t', `=${session}`, '-F', '#{window_index} #{window_name}']).catch(() => '')).split('\n').filter(Boolean).map(l => ({ index: Number(l.slice(0, l.indexOf(' '))), name: l.slice(l.indexOf(' ') + 1) })) })))
      },
      running: tmuxRunning,
      async end() { if (await tmuxRunning()) await tmux(['kill-session', '-t', `=${SESSION}`]) },
    },
    zellij: {
      bin: 'zellij',
      async prepare(look, dir, { session = SESSION, window = null } = {}) {
        // (another session's tab: brought forward first — zellij attaches where its session is)
        if (session !== SESSION && window != null) await run('zellij', ['--session', session, 'action', 'go-to-tab', String(Number(window) + 1)]).catch(() => {})
        // (closing the window detaches, whatever the person's on_force_close says)
        const attach = ['attach', ...(session === SESSION ? ['--create'] : []), session, 'options', '--on-force-close', 'detach', '--show-startup-tips', 'false', '--show-release-notes', 'false']
        if (zellijOwn()) return attach
        // no settings of their own: Ruyix's, in a file of ours handed over with --config — zellij writes a config of
        // its own (with the options it was started with) into ~/.config/zellij when it finds none, which would then
        // look like the person's. Ruyix's look, and no arrow separators (they need a Nerd Font the page does not have).
        const name = `ruyix-${look.tone}`, conf = join(dir, 'zellij.kdl')
        writeFileSync(conf, [
          '// Ruyix: how a terminal in Ruyix starts zellij while you have no ~/.config/zellij/config.kdl of your own',
          '// (written at each opening; make your own to change anything — Ruyix then uses yours)',
          `theme "${name}"`, 'simplified_ui true', 'show_startup_tips false', 'show_release_notes false', 'copy_on_select true', '',
          zellijTheme(name, look, ANSI[look.tone]),
        ].join('\n'), { mode: 0o600 })
        return ['--config', conf, ...attach]
      },
      running: zellijRunning,
      async end() { if (await zellijRunning()) await run('zellij', ['delete-session', '--force', SESSION]) },
      /** Its live sessions, each with its tabs (by position): [{ session, windows: [{ index, name }] }] */
      async sessions() {
        const names = String(await run('zellij', ['list-sessions', '--short', '--no-formatting']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean)
        return Promise.all(names.map(async session => ({ session, windows: String(await run('zellij', ['--session', session, 'action', 'query-tab-names']).catch(() => '')).split('\n').map(s => s.trim()).filter(Boolean).map((name, index) => ({ index, name })) })))
      },
    },
  }
}

/**
 * The terminals: `open(app, ws, { cols, rows, look })` starts one (a termpty.py running the app's multiplexer) and
 * ties it to a WebSocket; `state(apps)` says which sessions are there; `end(app)` ends one's session; `stopAll()` the
 * plugin going (the views close; the sessions stay — they are the person's).
 */
export function createTerms({ env = process.env, log = () => {}, spawn = nodeSpawn, execFile = nodeExecFile, python = 'python3', mux: given } = {}) {
  const home = env.HOME || homedir()
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { env: termEnv(env), cwd: home, timeout: 10000 }, (err, out) => (err ? reject(err) : resolve(out))))
  const mux = given || muxes({ env, home, run })
  const views = new Set()
  // the settings it writes: in the home, not /tmp — another user of the machine could make /tmp/<name> first and hand
  // Ruyix a folder of theirs, and tmux runs what its tmux.conf says
  const dir = () => {
    const d = join(home, '.ruyix', 'terminal')
    mkdirSync(d, { recursive: true, mode: 0o700 })
    const st = lstatSync(d)
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${d} is not a folder of this user's`)
    if (st.mode & 0o077) chmodSync(d, 0o700)
    return d
  }
  const of = app => mux[app?.mux] || null

  return {
    available: app => !!of(app) && !!onPath(of(app).bin, env) && !!onPath(python, env),
    async state(apps) {
      const out = {}
      for (const a of apps) out[a.id] = { running: onPath(of(a)?.bin || '-', env) ? await of(a).running() : false }
      return out
    },
    async end(app) { await of(app)?.end() },
    /** Every session of the apps' multiplexers: { [appId]: [{ session, windows }] } (one not on this machine: none). */
    async sessions(apps) {
      const out = {}
      for (const a of apps) out[a.id] = onPath(of(a)?.bin || '-', env) && of(a).sessions ? await of(a).sessions().catch(() => []) : []
      return out
    },
    /** A view: the pty for `ws` (wsConnection's), its size and look. Resolves once started; the view ends with ws. */
    async open(app, ws, { cols = 100, rows = 30, look = LOOK.light, session = SESSION, window = null } = {}) {
      const m = of(app)
      if (!SESSION_NAME.test(String(session)) || (window != null && !WINDOW_INDEX.test(String(window)))) throw new Error('no such session')
      const args = await m.prepare(look, dir(), { session, window: window == null ? null : Number(window) })
      // (-I: Python's isolated mode — no PYTHON* variables, nothing imported from beside the script or the home)
      const p = spawn(python, ['-I', PTY, String(cols), String(rows), '--', m.bin, ...args], { env: termEnv(env, look), cwd: home, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] })
      const view = { app: app.id, p }
      views.add(view)
      let ended = false
      const end = code => {
        if (ended) return
        ended = true
        views.delete(view)
        if (!ws.closed) { ws.send(Buffer.concat([Buffer.from([MSG.CONTROL]), Buffer.from(JSON.stringify({ exit: code }))])); ws.close(1000, 'the terminal ended') }
      }
      p.stdout.on('data', d => { if (!ws.send(Buffer.concat([Buffer.from([MSG.DATA]), d])) && !ws.closed) p.stdout.pause() })
      ws.socket.on('drain', () => p.stdout.resume())
      let err = ''
      p.stderr.on('data', d => { err = `${err}${d}`.slice(-2000) })
      p.on('error', e => { log(`apps: terminal ${app.id}: ${e.message}`); end(127) })
      p.on('exit', code => { if (code && err.trim()) log(`apps: terminal ${app.id} ended (${code}): ${err.trim().slice(-300)}`); end(code ?? 1) })
      for (const s of [p.stdin, p.stdio[3]]) s?.on('error', () => {}) // (the helper already gone)
      // keys faster than the program takes them (a long paste into a busy program): the page waits
      let held = false
      view.keys = buf => {
        if (p.stdin.destroyed || p.stdin.write(buf) || held) return
        held = true
        ws.pause()
        p.stdin.once('drain', () => { held = false; ws.resume() })
      }
      view.size = (c, r) => { if (!p.stdio[3]?.destroyed) p.stdio[3].write(`${c} ${r}\n`) }
      // the page gone: the terminal hangs up (the multiplexer detaches; its session stays), and goes for good if it lingers
      view.close = () => {
        if (ended) return
        p.stdin.end()
        setTimeout(() => { if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL') }, 3000).unref?.()
      }
      return view
    },
    stopAll() { for (const v of views) v.close() },
    /** how many views are open now */
    get viewing() { return views.size },
  }
}

/** The environment a terminal's programs start in: what dsh had, as a terminal says it (and not inside another multiplexer). */
export function termEnv(env, look) {
  const e = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Ruyix', LANG: env.LANG || 'C.UTF-8' }
  for (const k of ['TMUX', 'TMUX_PANE', 'ZELLIJ', 'ZELLIJ_SESSION_NAME', 'ZELLIJ_PANE_ID', 'DSH_TOKEN', 'NO_COLOR']) delete e[k]
  if (look) e.COLORFGBG = look.tone === 'dark' ? '15;0' : '0;15' // (what vim and others read for light or dark)
  return e
}

/** One message from the page: [kind, payload]. */
export function parseMessage(buf) {
  if (!buf?.length) return null
  return { kind: buf[0], body: buf.subarray(1) }
}
/** The size message's numbers, kept sane; null: not a size. */
export function parseSize(body) {
  const m = /^(\d{1,4}) (\d{1,4})$/.exec(String(body))
  if (!m) return null
  const cols = Math.min(1000, Math.max(2, +m[1])), rows = Math.min(1000, Math.max(1, +m[2]))
  return { cols, rows }
}
