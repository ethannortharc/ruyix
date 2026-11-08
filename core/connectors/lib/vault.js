// In a nookbox box: the host's vault, through the box's own window (NOOKBOX_API). A connector credential's value goes
// there and the box keeps the placeholder nookbox hands back; the gateway puts the value back only into requests to
// the connection's hosts. nookbox lets a box set only its connector credentials (CONN_…), and their hosts only once.
export const PLACEHOLDER = /NKB[A-Za-z0-9]{32}/

export function boxVault(base, fetchFn = globalThis.fetch) {
  if (!base) return null
  const call = async (method, name, body) => {
    const res = await fetchFn(new URL(`/v1/secrets/${encodeURIComponent(name)}`, base), {
      method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(`nookbox vault: ${data.error || `HTTP ${res.status}`}`), { code: 'vault', params: { detail: data.error || `HTTP ${res.status}` }, status: res.status })
    return data
  }
  return {
    /** Store a value: → { placeholder, hosts }. `hosts` fix where it may go (a credential made now). */
    put: (name, { value, hosts, body = false }) => call('PUT', name, { value, hosts, body }),
    /** Clear a value (gone already: fine). */
    remove: name => call('DELETE', name).catch(err => { if (err.status !== 404) throw err }),
    /** The box's egress policy (its window's /v1/box): which hosts its gateway intercepts on a private CA (`trust`). */
    async policy() {
      const res = await fetchFn(new URL('/v1/box', base), { signal: AbortSignal.timeout(15000) })
      if (!res.ok) throw Object.assign(new Error(`nookbox box: HTTP ${res.status}`), { code: 'vault', params: { detail: `HTTP ${res.status}` }, status: res.status })
      return (await res.json())?.box?.spec?.policy || null
    },
  }
}
