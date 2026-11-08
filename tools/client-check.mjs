// Every plugin's client.js is a dsh client plugin: the module the loader gets exports apply (and inject). One that does
// not makes dsh refuse to load any plugin ("Failed to load plugins"), so dev-install runs this before linking.
// Usage: node tools/client-check.mjs [plugin dirs…] (default: every core/ package with dsh.client)
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Watch notifications use native separators; both platforms must select the same client sources.
const { client: watchClient } = await import('./dev-watch.mjs')
for (const path of ['workbench/src/chat.jsx', 'workbench\\src\\chat.jsx', 'plugins/apps/src/main.jsx']) if (!watchClient(path)) throw Error(`watch misses ${path}`)
for (const path of ['workbench/client.js', 'workbench\\client.js', 'node_modules/x/src/main.js', 'workbench/index.js']) if (watchClient(path)) throw Error(`watch includes ${path}`)

const root = fileURLToPath(new URL('..', import.meta.url))
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : ['core/shell', 'core/connectors', 'core/workbench', ...readdirSync(join(root, 'core/plugins')).map(d => `core/plugins/${d}`), ...readdirSync(join(root, 'packs')).map(d => `packs/${d}`)]
const bad = []
const reactDir = process.env.RUYIX_REACT_DIR || join(homedir(), '.dsh', 'profiles', 'node_modules')
const req = createRequire(join(realpathSync(join(reactDir, 'react-dom')), 'x.js'))
const react = { react: req('react'), 'react/jsx-runtime': req('react/jsx-runtime'), 'react-dom': req('react-dom'), 'react-dom/client': req('react-dom/client') }
const stub = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === '__esModule' ? false : stub), apply: () => stub, construct: () => stub })
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
  if (!pkg.dsh?.client) continue
  const file = join(root, dir, 'client.js')
  if (!existsSync(file)) { bad.push(`${dir}: no client.js (node build.mjs)`); continue }
  let got = null
  // the bundle only registers its factory; the factory is not run (it would need React and dsh)
  const window = { __ModuleLoader__: { load: m => { got = m } } }
  new Function('window', readFileSync(file, 'utf8'))(window)
  if (got?.id !== pkg.name) { bad.push(`${dir}: the bundle registers "${got?.id}", not ${pkg.name}`); continue }
  // run the factory with React (dsh's own, the one the client gets) and stubs for the rest: enough for the module's
  // top level to define its exports
  let exports
  try { exports = got.factory(name => react[name] || stub) } catch (err) { bad.push(`${dir}: the module's top level throws: ${err.message}`); continue }
  if (typeof exports?.apply !== 'function') bad.push(`${dir}: client.js exports no apply() — dsh would load no plugin at all`)
}
// A name a file re-exports (`export { x } from './y.js'`) is not bound in that file: using it there throws "x is not
// defined" only when that code runs — the bundle is built without a word (2026-10-18: the workbench's task list). Each
// such name the file uses itself is imported (or declared) there too.
const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(join(d, e.name))) : /\.(m?js|jsx)$/.test(e.name) ? [join(d, e.name)] : []))
const esc = n => n.replace(/\$/g, '\\$')
for (const dir of dirs) {
  for (const f of [join(root, dir, 'src'), join(root, dir, 'lib')].filter(existsSync).flatMap(walk)) {
    const code = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/g, '$1') // (comments out)
    for (const m of code.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g)) {
      const rest = code.replace(m[0], '')
      for (const n of m[1].split(',').flatMap(x => x.trim().split(/\s+as\s+/)).map(x => x.trim()).filter(x => /^[\w$]+$/.test(x) && x !== 'default')) {
        // used here: not as a property (x.n) or an object key (n: …)
        if (!new RegExp(`(^|[^\\w$.])${esc(n)}\\b(?!\\s*:)`, 'm').test(rest)) continue
        if (new RegExp(`import\\s*\\{[^}]*\\b${esc(n)}\\b[^}]*\\}\\s*from|import\\s+${esc(n)}\\b|\\b(const|let|var|function|class)\\s+${esc(n)}\\b`).test(rest)) continue
        bad.push(`${f.slice(root.length)}: uses ${n}, which it only re-exports (export { ${n} } from …) — import it too`)
      }
    }
  }
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1) }
console.log('client check: ok')
