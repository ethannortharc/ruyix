// A small WebSocket server side (RFC 6455) for the one thing this plugin needs: carrying a VNC stream between the
// browser and a display's port. Binary messages, fragmentation, ping/pong and the closing handshake; no extensions
// (permessage-deflate is not offered back, so the browser sends plain frames). Written here rather than pulled in
// (`ws`) because the whole job is a page of code and the plugin otherwise has no runtime dependency.
import { createHash } from 'node:crypto'
import { connect } from 'node:net'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }
/** A larger message than this closes the connection (1009): VNC's own messages are far smaller. */
export const MAX_MESSAGE = 16 << 20

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export const acceptKey = key => createHash('sha1').update(`${key}${GUID}`).digest('base64')

/** One frame's bytes. `mask` (4 bytes) is for a client's frames — a server sends unmasked. */
export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = null } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const n = data.length
  const head = Buffer.alloc(2 + (n < 126 ? 0 : n < 65536 ? 2 : 8) + (mask ? 4 : 0))
  head[0] = (fin ? 0x80 : 0) | opcode
  let at = 2
  if (n < 126) head[1] = n
  else if (n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); at = 4 } else { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); at = 10 }
  if (!mask) return Buffer.concat([head, data])
  head[1] |= 0x80
  mask.copy(head, at)
  const out = Buffer.allocUnsafe(n)
  for (let i = 0; i < n; i++) out[i] = data[i] ^ mask[i & 3]
  return Buffer.concat([head, out])
}

/**
 * Frames out of a byte stream: push(chunk) → the complete frames so far ({ fin, opcode, payload }, unmasked).
 * `requireMask`: a server refuses a client's unmasked frame (RFC 6455 §5.1). Throws { code: 1002 | 1009 } on a
 * protocol error or an oversized frame — the caller closes with that code.
 */
export function frameReader({ requireMask = true, max = MAX_MESSAGE } = {}) {
  let buf = Buffer.alloc(0)
  const fail = (code, why) => Object.assign(new Error(why), { closeCode: code })
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    const frames = []
    for (;;) {
      if (buf.length < 2) break
      const b0 = buf[0], b1 = buf[1]
      if (b0 & 0x70) throw fail(1002, 'reserved bits set (no extension was agreed)')
      const masked = !!(b1 & 0x80)
      if (requireMask && !masked) throw fail(1002, 'a client frame must be masked')
      let len = b1 & 0x7f, at = 2
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4 } else if (len === 127) {
        if (buf.length < 10) break
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(max)) throw fail(1009, 'frame too large')
        len = Number(big); at = 10
      }
      if (len > max) throw fail(1009, 'frame too large')
      const opcode = b0 & 0x0f, fin = !!(b0 & 0x80)
      if (opcode >= 0x8 && (!fin || len > 125)) throw fail(1002, 'a control frame must be whole and short')
      const need = at + (masked ? 4 : 0) + len
      if (buf.length < need) break
      let payload = buf.subarray(at + (masked ? 4 : 0), need)
      if (masked) {
        const m = buf.subarray(at, at + 4), out = Buffer.allocUnsafe(len)
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3]
        payload = out
      } else payload = Buffer.from(payload)
      frames.push({ fin, opcode, payload })
      buf = buf.subarray(need)
    }
    return frames
  }
}

/** The handshake's answer for `req`, or { status, reason } when it is no WebSocket request we take. */
export function handshake(req) {
  const h = req.headers
  if (req.method !== 'GET') return { status: 405, reason: 'Method Not Allowed' }
  if (!/\bwebsocket\b/i.test(h.upgrade || '') || !/\bupgrade\b/i.test(h.connection || '')) return { status: 400, reason: 'Bad Request' }
  if (String(h['sec-websocket-version'] || '') !== '13') return { status: 426, reason: 'Upgrade Required', headers: ['Sec-WebSocket-Version: 13'] }
  const key = String(h['sec-websocket-key'] || '')
  if (Buffer.from(key, 'base64').length !== 16) return { status: 400, reason: 'Bad Request' }
  // noVNC offers 'binary' on request; an empty or other offer gets no protocol (binary frames all the same)
  const offered = String(h['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).filter(Boolean)
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`]
  if (offered.includes('binary')) lines.push('Sec-WebSocket-Protocol: binary')
  return { response: `${lines.join('\r\n')}\r\n\r\n` }
}

/** Refuse an upgrade with a plain HTTP answer (the socket is not a WebSocket yet). */
export function refuse(socket, status, reason, headers = []) {
  socket.end([`HTTP/1.1 ${status} ${reason}`, 'Connection: close', 'Content-Length: 0', ...headers, '', ''].join('\r\n'))
}

/**
 * A WebSocket over an upgraded socket (after the 101 is written): onMessage(Buffer) for each whole binary message,
 * send(Buffer) a binary message, close(code, reason). Pings are answered, a close is echoed. `head` is what the HTTP
 * parser read past the request (the first frames, if the client was quick). Back-pressure: pause()/resume() the
 * reading side; send() returns false when the socket's buffer is full ('drain' on the socket says when it is not).
 */
export function wsConnection(socket, head = Buffer.alloc(0), { onMessage = () => {}, onClose = () => {}, pingMs = 30000, max = MAX_MESSAGE } = {}) {
  const read = frameReader({ requireMask: true, max })
  let parts = [], size = 0, kind = 0, closed = false, closeSent = false, heard = Date.now()
  socket.setNoDelay?.(true)
  const write = buf => (socket.destroyed ? false : socket.write(buf))
  const finish = (code, reason) => {
    if (closed) return
    closed = true
    clearInterval(timer)
    onClose(code, reason)
  }
  const close = (code = 1000, reason = '') => {
    if (!closeSent && !socket.destroyed) {
      closeSent = true
      const r = Buffer.from(String(reason).slice(0, 120))
      const body = Buffer.alloc(2 + r.length); body.writeUInt16BE(code, 0); r.copy(body, 2)
      socket.end(encodeFrame(OP.CLOSE, body))
    }
    // a peer that never answers the close: the socket goes after a moment all the same
    setTimeout(() => socket.destroy(), 2000).unref?.()
    finish(code, reason)
  }
  const onData = chunk => {
    heard = Date.now()
    let frames
    try { frames = read(chunk) } catch (err) { close(err.closeCode || 1002, err.message); return }
    for (const f of frames) {
      if (closed) return
      if (f.opcode === OP.PING) { write(encodeFrame(OP.PONG, f.payload)); continue }
      if (f.opcode === OP.PONG) continue
      if (f.opcode === OP.CLOSE) {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1000
        close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code)
        return
      }
      if (f.opcode === OP.TEXT || f.opcode === OP.BINARY) {
        if (kind) { close(1002, 'a new message inside a fragmented one'); return }
        kind = f.opcode
      } else if (f.opcode === OP.CONT) {
        if (!kind) { close(1002, 'a continuation with nothing to continue'); return }
      } else { close(1002, `unknown opcode ${f.opcode}`); return }
      parts.push(f.payload); size += f.payload.length
      if (size > max) { close(1009, 'message too large'); return }
      if (!f.fin) continue
      const msg = parts.length === 1 ? parts[0] : Buffer.concat(parts, size), was = kind
      parts = []; size = 0; kind = 0
      // VNC is binary; a text message is no part of it
      if (was === OP.TEXT) { close(1003, 'binary messages only'); return }
      onMessage(msg)
    }
  }
  socket.on('data', onData)
  // the peer gone without a close (a tab killed, the network down): Node's HTTP server hands an upgraded socket over
  // half-open, so its end alone would never close it — it does here
  socket.on('end', () => socket.destroy())
  socket.on('close', () => finish(1006, 'connection lost'))
  socket.on('error', () => socket.destroy())
  // a quiet ping now and then keeps proxies (and the browser) from dropping an idle display; a peer that has answered
  // nothing for two of them is gone (the network down, a laptop asleep: no FIN ever comes) — its side goes now, not at
  // TCP's timeout many minutes later
  const timer = pingMs ? setInterval(() => {
    if (Date.now() - heard > 2 * pingMs + 1000) { socket.destroy(); return }
    write(encodeFrame(OP.PING))
  }, pingMs) : null
  timer?.unref?.()
  if (head?.length) onData(head)
  return {
    send: buf => (closed || closeSent ? false : write(encodeFrame(OP.BINARY, buf))),
    close,
    pause: () => socket.pause(),
    resume: () => socket.resume(),
    get closed() { return closed },
    socket,
  }
}

/**
 * The bridge: an upgraded socket ↔ TCP 127.0.0.1:`port` (a display's VNC server). Whatever ends first ends the other.
 * Returns the WebSocket (for the caller to close when the session goes).
 */
/**
 * Is a VNC client's message the person at the keys or the mouse (RFB: a key pressed, a button down)? Messages may come
 * several to a frame; the handshake's (before them) is no such message.
 */
export function personInputIn(buf) {
  for (let i = 0; i < buf.length;) {
    const t = buf[i]
    if (t === 4) { if (buf[i + 1] === 1) return true; i += 8 } else if (t === 5) { if (buf[i + 1]) return true; i += 6 } else if (t === 3) i += 10
    else if (t === 0) i += 20
    else if (t === 2) i += 4 + 4 * buf.readUInt16BE(i + 2)
    else if (t === 6) i += 8 + buf.readUInt32BE(i + 4)
    else return false
  }
  return false
}

export function bridge(socket, head, { port, host = '127.0.0.1', connectTimeoutMs = 5000, pingMs, onEnd = () => {}, onInput = null }) {
  const tcp = connect({ host, port })
  let ws = null
  const early = [] // what the browser sent before the TCP side was up
  ws = wsConnection(socket, head, {
    pingMs,
    onMessage: msg => {
      if (onInput) { try { onInput(msg) } catch { /* the watcher's own trouble */ } }
      if (tcp.connecting) { early.push(msg); return }
      if (!tcp.write(msg)) ws.pause()
    },
    onClose: () => { tcp.end(); setTimeout(() => tcp.destroy(), 1000).unref?.(); onEnd() },
  })
  tcp.setNoDelay(true)
  const t = setTimeout(() => tcp.destroy(new Error('connect timeout')), connectTimeoutMs)
  tcp.on('connect', () => { clearTimeout(t); for (const m of early.splice(0)) tcp.write(m) })
  tcp.on('drain', () => ws.resume())
  socket.on('drain', () => tcp.resume())
  tcp.on('data', d => { if (!ws.send(d) && !ws.closed) tcp.pause() })
  tcp.on('error', () => {}) // 'close' follows
  tcp.on('close', hadError => { clearTimeout(t); if (!ws.closed) ws.close(hadError ? 1011 : 1000, hadError ? 'the display is not answering' : 'the display closed') })
  return ws
}
