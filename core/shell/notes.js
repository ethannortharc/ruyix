// The desk's notes (the note widgets): each note's text by its widget's id, in ~/.ruyix/notes.json — written as typed,
// so not a surface (a change record per keystroke would bury the real ones). At most MAX notes of MAX_TEXT characters.
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX = 24
export const MAX_TEXT = 8000
const ID = /^[a-z0-9]{1,12}$/

export function createNotes({ home }) {
  const file = join(home, 'notes.json')
  const read = () => { try { const v = JSON.parse(readFileSync(file, 'utf8')); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} } }
  const write = v => { writeFileSync(`${file}.tmp`, `${JSON.stringify(v, null, 2)}\n`); renameSync(`${file}.tmp`, file) }
  const fail = (code, message) => Object.assign(new Error(message), { code, status: 400 })
  return {
    all: () => ({ notes: read() }),
    /** { id, text } — an empty text removes the note. */
    save({ id, text } = {}) {
      if (!ID.test(id ?? '')) throw fail('badNote', 'a note is { id: [a-z0-9]{1,12}, text }')
      if (typeof text !== 'string') throw fail('badNote', 'text: a string')
      const notes = read()
      if (text) {
        if (!Object.hasOwn(notes, id) && Object.keys(notes).length >= MAX) throw fail('tooMany', `at most ${MAX} notes`)
        notes[id] = text.slice(0, MAX_TEXT)
      } else delete notes[id]
      write(notes)
      return { notes }
    },
  }
}
