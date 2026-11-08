// What a plugin needs to make a map of its own for the interactive desk without starting from nothing:
// registerWorld(def) and the World it renders, the places (layout.js), the words (words.js), the two sets of pictures.
export { registerWorld } from './register.jsx'
export { World } from './world.jsx'
export { KINDS, KNOWN, WORLD, placesOf, islandsOf, fit, clampView, zoomAt, toScreen, toWorld } from './layout.js'
export { WORDS, wordsFor, fmt } from './words.js'
export { ATLAS_ICONS, SKY_ICONS, Icon } from './icons.jsx'
