// Ruyix was called Aviary until 2026-10-16, then Agnos for a day: what this browser remembered under an old name (the desk, the windows'
// places, the last tab, the pixels of a Linux app…) moves over once. Imported first, before anything reads it.
try {
  for (const k of Object.keys(localStorage)) {
    const n = k.replace(/^(?:aviary|agnos)(?=[.-])/, 'ruyix')
    if (n === k) continue
    if (localStorage.getItem(n) === null) localStorage.setItem(n, localStorage.getItem(k))
    localStorage.removeItem(k)
  }
} catch { /* no storage here (a private window): nothing to move */ }
