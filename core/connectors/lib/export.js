// The connections as a configuration file carries them (ruyix config export/import, nookbox up --config): the connections
// themselves (no value), the credentials they hold as nookbox secrets — each slot one secret, its hosts the
// connection's — and, only when asked, the values by secret name. Nothing is guessed from names.
import { TYPES } from './types.js'

export const secretName = (id, slot) => `CONN_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}__${slot.toUpperCase()}`
export const importDir = '~/.ruyix/connectors/import'

/** One slot as a nookbox secret: a file is placed in the box (the import takes it in), a header token is swapped per host. */
export function secretOf(c, slot, types = TYPES) {
  const def = types[c.type].slots.find(s => s.name === slot)
  const name = secretName(c.id, slot), use = [{ to: 'connection', id: c.id, slot }]
  if (def.file) return { name, kind: 'file', use: [{ ...use[0], path: `${importDir}/${c.id}.${slot}` }] }
  // a session (its type's browser sign-in) goes as a cookie
  if (def.signin || (c.signin && c.signin === slot)) return { name, kind: 'cookie', hosts: c.hosts, login: c.type, use }
  // git over https (a box's clones and pushes) takes the GitLab token that can push, else the one that reads
  const git = c.type === 'gitlab' && slot === (c.slots.includes('write') ? 'write' : 'read')
  // a user and password go in a sign-in form's body, not a header
  return { name, kind: git ? 'gitlab' : 'http', hosts: c.hosts, ...(c.type === 'http' && ['user', 'password'].includes(slot) && { body: true }), use }
}

/** connections: [{ id, type, name, baseUrl, hosts (all), ownHosts, fields, slots: names set }]; values: secret name → value. */
export function exportConnections(connections, values = null, types = TYPES) {
  return {
    connections: connections.map(c => ({ id: c.id, type: c.type, name: c.name, ...(c.baseUrl && { baseUrl: c.baseUrl }), ...(c.ownHosts?.length && { hosts: c.ownHosts }), fields: c.fields })),
    secrets: connections.flatMap(c => c.slots.map(slot => secretOf(c, slot, types))),
    ...(values && { values }),
  }
}
