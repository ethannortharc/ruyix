// A form edits only its own changes; run-driven status and other newer fields stay on the server.
export const recordPatch = (coll, draft, before) => ({
  ...(before?.id && { id: before.id }),
  ...Object.fromEntries(Object.entries(draft).filter(([k, v]) => coll.fields.some(f => f.name === k) && (!before || JSON.stringify(v) !== JSON.stringify(before[k])))),
})
