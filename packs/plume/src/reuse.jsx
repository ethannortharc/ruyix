import { useState } from 'react'
import { CopyPlus, Loader2 } from 'lucide-react'
import { tr } from './locale.js'

export function ReuseButton({ run, call, lang, disabled }) {
  const t = tr(lang), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const reuse = async () => {
    setBusy(true); setError('')
    try {
      const { idea } = await call('reuse', { run: run.id })
      window.dispatchEvent(new CustomEvent('ruyix:studio', { detail: { studio: 'plume', collection: 'ideas' } }))
      window.dispatchEvent(new CustomEvent('ruyix:open', { detail: { panel: 'ruyix-studio-plume', studio: 'plume', collection: 'ideas', record: idea.id } }))
    } catch (err) { setError(err.message) }
    finally { setBusy(false) }
  }
  return <div className="pl-form-actions"><button className="wb-btn wb-small" disabled={busy || disabled} onClick={reuse}>{busy ? <Loader2 size={12} className="wb-spin" /> : <CopyPlus size={12} />}{t('pl.reuse')}</button>{error && <span className="wb-c-red">{error}</span>}</div>
}
