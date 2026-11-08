// dsh's preview notice (its first-run dialog): ruyix acknowledges it in cordis.patch.yml, but dsh keeps that on the Host
// only for a browser on this machine — one over Tailscale was asked again on every load. For those the shell hides it
// and presses its Continue: the acknowledgement stays in that page, as dsh's own does for such a browser.
export const NOTICE_CSS = '@deepseek-ai/dsh-client-ui-settings-models/WelcomeNotice.module.css'
/** The notice's class prefix, read from its own stylesheet (it changes with dsh's builds). */
export const noticePrefix = text => String(text || '').match(/\.([\w-]+)_copy\{/)?.[1] || ''
/** Hides the notice's dialog (portaled under body, or a <dialog> with its backdrop) while it is acknowledged. */
export const noticeHideCss = p => (p ? `body > :has(.${p}_copy), dialog:has(.${p}_copy), dialog:has(.${p}_copy)::backdrop { opacity: 0 !important; pointer-events: none !important; }` : '')
