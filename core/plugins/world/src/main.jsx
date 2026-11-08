// The interactive desk's client: it gives the shell its maps (window.__ruyixWorlds; desktop.json mode `world`) — the
// old map, the star map and the future — each from a definition (registerWorld, register.jsx).
import { registerWorld } from './register.jsx'
import { atlas } from './atlas.jsx'
import { sky } from './sky.jsx'
import { future } from './future.jsx'

export function apply(ctx) {
  ctx.effect(() => {
    const off = [atlas, sky, future].map(registerWorld)
    return () => off.forEach(f => f())
  }, 'world: the maps')
}
export { registerWorld }
