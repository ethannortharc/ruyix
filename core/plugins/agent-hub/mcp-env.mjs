#!/usr/bin/env node
// Starts a member's MCP server with environment read from a 0600 file: a run token is never on a command line
// (/proc/<pid>/cmdline is readable by every local user). argv: <env.json> <command> [args…]. The hub removes the file.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const [file, command, ...args] = process.argv.slice(2)
const child = spawn(command, args, { env: { ...process.env, ...JSON.parse(readFileSync(file, 'utf8')) }, stdio: 'inherit' })
child.on('exit', (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)))
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => child.kill(s))
