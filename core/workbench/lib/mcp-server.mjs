#!/usr/bin/env node
// MCP stdio server for Claude Code / Codex agents of a workbench run. It only lists the workbench tools and
// forwards calls to the dsh Host (a Unix socket of its own, one token per step), which runs them and writes the evidence —
// so a call from here is exactly the same as a call from a dsh agent.
import { createInterface } from 'node:readline'
import { toolsPost } from './mcp-client.mjs'

const { RUYIXWB_URL: url, RUYIXWB_TOKEN: token, RUYIXWB_NAME: name = 'ruyix-workbench' } = process.env
// (its Unix socket, or an http address; a failure says where it asked)
// (a tool's call as long as it takes — a test run, a repro: minutes —; the list in 20 s)
const post = (path, body) => toolsPost(url, token, path, body, { timeout: path === '/call' ? 0 : 20000 }).catch(err => { throw new Error(`the workbench's tools at ${url} do not answer: ${err.message}`) })
const send = msg => process.stdout.write(`${JSON.stringify(msg)}\n`)

async function handle(m) {
  switch (m.method) {
    case 'initialize':
      return { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '0.1.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: (await post('/tools', {})).tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters })) }
    case 'tools/call':
      try {
        const r = await post('/call', { name: m.params?.name, args: m.params?.arguments || {} })
        return { content: [{ type: 'text', text: r.text }] }
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true }
      }
    default:
      throw Object.assign(new Error(`method not found: ${m.method}`), { code: -32601 })
  }
}

createInterface({ input: process.stdin }).on('line', async line => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id === undefined || m.id === null) return // notifications need no answer
  try {
    send({ jsonrpc: '2.0', id: m.id, result: await handle(m) })
  } catch (err) {
    send({ jsonrpc: '2.0', id: m.id, error: { code: err.code || -32603, message: err.message } })
  }
})
