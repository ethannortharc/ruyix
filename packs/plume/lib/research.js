// Research is a deliverable: readable notes plus a normalized, inspectable source list.
export function researchSources(value) {
  if (!Array.isArray(value) || !value.length || value.length > 60) throw new Error('sources: list 1–60 sources actually read')
  const seen = new Set()
  return value.map((s, i) => {
    if (!s || typeof s.title !== 'string' || !s.title.trim() || typeof s.url !== 'string') throw new Error(`source ${i + 1}: title and URL are required`)
    let url
    try { url = new URL(s.url) } catch { throw new Error(`source ${i + 1}: invalid URL`) }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`source ${i + 1}: use an HTTP(S) URL without credentials`)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key)
    url.searchParams.sort()
    const normalized = url.href.replace(/\/$/, '')
    if (seen.has(normalized)) throw new Error(`source ${i + 1}: duplicate URL; merge duplicate sources and renumber citations`)
    seen.add(normalized)
    return { id: i + 1, title: s.title.trim().slice(0, 400), url: url.href,
      ...(typeof s.publishedAt === 'string' && { publishedAt: s.publishedAt.slice(0, 80) }),
      ...(typeof s.evidence === 'string' && { evidence: s.evidence.slice(0, 3000) }) }
  })
}

export function checkResearchNotes(text, sources) {
  if (typeof text !== 'string' || text.trim().length < 80) throw new Error('Write substantive research.md before finishing research')
  const citations = [...text.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]))
  if (!citations.length || citations.some(id => !sources.some(s => s.id === id))) throw new Error('research.md must use valid [n] source citations')
  for (const s of sources) if (!text.includes(`[${s.id}]`)) throw new Error(`source ${s.id} is unused in research.md`)
  return true
}
