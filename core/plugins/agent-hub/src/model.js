/**
 * The model a member card shows: what its running task really uses, else the configured one; a finished task's
 * model only when it ran on the member's current runtime (after a switch to Codex, an old Claude model is stale).
 */
export const shownModel = (def, current, last) => current?.model || def.model || (last && (last.runtime || def.runtime) === def.runtime ? last.model : '') || ''
