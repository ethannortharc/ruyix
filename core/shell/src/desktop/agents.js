// Each kind of agent's colour, the same everywhere (the strip of the work going on, the collaboration graph; the maps
// draw theirs in the same hues): Claude orange, Codex cyan, dsh violet. Light themes get the deeper ink of each.
export const AGENT_COLOR = {
  claude: 'light-dark(#c2511d, #ff9f6b)',
  codex: 'light-dark(#0b7fb0, #5ec8ff)',
  dsh: 'light-dark(#6d4fd8, #a493ff)',
  model: 'light-dark(#6d4fd8, #a493ff)',
  pi: 'light-dark(#1f8a5c, #7fe0b4)',
  system: 'light-dark(#5d6d82, #9fb0c2)',
  person: 'light-dark(#a36a00, #f5b335)',
}
export const agentColor = kind => AGENT_COLOR[kind] || AGENT_COLOR.model
