// Ruyix as an app of its own: the web app manifest, so Chrome's "Install" (or Edge's) and Safari's "Add to Dock" make
// a Ruyix icon that opens it in a window without the browser's tabs and address bar — and ⌃⌘F there puts it on the
// whole screen, in a Space of its own on a Mac. The icons are the mark (mark.js) drawn to PNG once (assets/): as it is
// with a Mac icon's margin, full bleed for a system that rounds it itself ('maskable'; iOS and Safari's touch icon).
// The manifest carries its icons inline: the browser fetches them with or without the sign-in's cookie, either works.
import { readFileSync } from 'node:fs'

const asset = name => readFileSync(new URL(`./assets/${name}`, import.meta.url))
const inline = name => `data:image/png;base64,${asset(name).toString('base64')}`

/** The manifest (served at api/ruyix/app.webmanifest: the page itself is two folders up). */
export function appManifest() {
  return {
    id: '../../',
    name: 'Ruyix',
    short_name: 'Ruyix',
    description: 'Your agents, their tools and your apps on one desktop',
    start_url: '../../',
    scope: '../../',
    display: 'standalone',
    background_color: '#0b1214',
    icons: [
      { src: inline('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: inline('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: inline('icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}

/** Safari's icon for the Dock and the home screen (it takes no data: link, and none from a manifest). */
export const touchIcon = () => asset('apple-touch-icon.png')
