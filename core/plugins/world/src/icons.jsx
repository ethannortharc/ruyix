// The places' pictures, a set per map (kind → SVG; the kinds: layout.js KINDS): the old map's in ink (a town, a ship, a
// compass…), the star map's in lines of light (a sun, a planet, an observatory…). A village (a page nobody knows yet) is
// the set's `village` with the page's own icon on it.
const S = { viewBox: '0 0 64 64', fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }

export const ATLAS_ICONS = {
  // the capital: walls, two towers, a keep with a vermilion banner
  capital: <svg {...S}><path d="M10 52h44M14 52V34h8v18M42 52V34h8v18M22 40h20v12M26 52v-7a6 6 0 0 1 12 0v7M24 40V26h16v14M24 26l8-8 8 8M32 18V8" /><path d="M32 8l9 3-9 3z" className="wd-red" /><path d="M14 34l4-4 4 4M42 34l4-4 4 4" /></svg>,
  // the harbour: a pier, moored boats
  harbor: <svg {...S}><path d="M6 44h52M14 44v10M24 44v10M34 44v10M8 30h22l-4 8H12z" /><path d="M19 30V16l9 12h-9" /><path d="M36 38h20l-3 6H39z" /><path d="M46 38V26l7 10" /><path d="M6 58c4-2 8 2 12 0s8 2 12 0 8 2 12 0 8 2 12 0" /></svg>,
  // the ship that sets sail: a new task
  launch: <svg {...S}><path d="M10 42h44l-7 10H17z" /><path d="M32 42V8" /><path d="M32 10c10 4 14 14 14 26H32" className="wd-paper" /><path d="M32 14c-8 4-12 12-12 22h12" className="wd-paper" /><path d="M32 8l8 2-8 2" className="wd-red" /><path d="M4 58c5-2 9 2 14 0s9 2 14 0 9 2 14 0 9 2 14 0" /></svg>,
  // the post station: a house, a hitched horse's post, letters with a vermilion seal
  post: <svg {...S}><path d="M8 30l18-14 18 14M12 28v24h28V28M22 52V40h8v12" /><path d="M44 52V36h12v16z" className="wd-paper" /><path d="M44 36l6 6 6-6" /><circle cx="50" cy="47" r="2.5" className="wd-red" /></svg>,
  // the library: a two-roofed hall, books on shelves
  library: <svg {...S}><path d="M6 26h52L32 12zM10 34h44l-6-8H16zM14 34v20h36V34" /><path d="M20 38v12M25 38v12M30 38v12M36 38v12M41 38v12M46 38v12" /><path d="M10 54h44" /></svg>,
  // the guild of agents: a hall with banners
  guild: <svg {...S}><path d="M10 54V30l22-14 22 14v24zM26 54V40h12v14" /><path d="M16 30V12M48 30V12" /><path d="M16 12l8 3-8 3z" className="wd-red" /><path d="M48 12l8 3-8 3z" className="wd-red" /></svg>,
  // the workshop town: houses, a chimney with smoke, a cogwheel sign
  workshop: <svg {...S}><path d="M6 54V36l10-8 10 8v18zM26 54V30l12-9 12 9v24zM50 54V40l8-5" /><path d="M42 21V12h5v13" /><path d="M44 8c2-3 6-3 7 0s4 3 6 0" /><circle cx="38" cy="40" r="5" /><path d="M38 33v2M38 45v2M31 40h2M43 40h2" /></svg>,
  // the ferry: a lighthouse on a rock, its beam out to sea
  port: <svg {...S}><path d="M24 54l4-34h8l4 34zM26 20h12l-2-6h-8zM32 14V9" /><path d="M14 54h36M18 36h-12M46 36h12M18 30l-10-4M46 30l10-4" className="wd-beam" /><path d="M26 32h12M25 42h14" /></svg>,
  // the fort: crenellated walls round a gate (the box everything runs in)
  fort: <svg {...S}><path d="M8 54V28h6v4h6v-4h6v4h6v-4h6v4h6v-4h6v4h6v-4h6v26z" /><path d="M26 54V44a6 6 0 0 1 12 0v10" /></svg>,
  // the records: a tower of scrolls
  archive: <svg {...S}><path d="M18 54V20h28v34zM14 20h36l-4-8H18z" /><path d="M24 28h16M24 34h16M24 40h16M24 46h16" /><circle cx="24" cy="28" r="1.5" /><circle cx="24" cy="34" r="1.5" /><circle cx="24" cy="40" r="1.5" /></svg>,
  // the settings: a compass rose
  settings: <svg {...S}><circle cx="32" cy="32" r="22" /><circle cx="32" cy="32" r="18" /><path d="M32 4l4 24-4 4-4-4zM32 60l-4-24 4-4 4 4zM4 32l24-4 4 4-4 4zM60 32l-24 4-4-4 4-4z" className="wd-paper" /><path d="M32 4l4 24-4 4z" className="wd-red" /><path d="M14 14l12 15M50 50 38 35M50 14 35 29M14 50l15-12" /></svg>,
  // the gate back to the desktop: a stone stele
  gate: <svg {...S}><path d="M20 54V18a12 12 0 0 1 24 0v36zM14 54h36" /><path d="M28 24h8M28 30h8M28 36h8M28 42h8" /></svg>,
  village: <svg {...S}><path d="M14 54V32l18-14 18 14v22z" className="wd-paper" /></svg>,
}

export const SKY_ICONS = {
  // the capital: a sun with its rays (the shader draws its glow)
  capital: <svg {...S}><circle cx="32" cy="32" r="9" /><path d="M32 8v8M32 48v8M8 32h8M48 32h8M15 15l6 6M43 43l6 6M49 15l-6 6M15 49l6-6" /></svg>,
  // the star port: a docking ring with a ship
  harbor: <svg {...S}><ellipse cx="32" cy="34" rx="24" ry="9" /><path d="M8 34c0 6 11 10 24 10s24-4 24-10" /><path d="M26 24l6-10 6 10-6 4z" /></svg>,
  // a new star to light: a four-pointed spark
  launch: <svg {...S}><path d="M32 6c2 14 6 18 20 20-14 2-18 6-20 20-2-14-6-18-20-20 14-2 18-6 20-20z" /><path d="M48 44l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" /></svg>,
  // the beacon: a mast sending rings
  post: <svg {...S}><path d="M32 58V28M24 58l8-22 8 22" /><circle cx="32" cy="24" r="4" /><path d="M22 16a14 14 0 0 1 20 0M16 10a22 22 0 0 1 32 0" /></svg>,
  // the workflows: a constellation
  library: <svg {...S}><path d="M10 46l12-14 12 6 10-16 12 8" /><circle cx="10" cy="46" r="3" /><circle cx="22" cy="32" r="3" /><circle cx="34" cy="38" r="3" /><circle cx="44" cy="22" r="3" /><circle cx="56" cy="30" r="3" /></svg>,
  // the fleet of agents: three ships
  guild: <svg {...S}><path d="M32 10l6 16H26zM14 30l5 13h-10zM50 30l5 13H45z" /><path d="M32 26v8M14 43v6M50 43v6" /></svg>,
  // the apps: a ringed planet
  workshop: <svg {...S}><circle cx="32" cy="32" r="13" /><ellipse cx="32" cy="32" rx="26" ry="8" transform="rotate(-20 32 32)" /></svg>,
  // the connections: a relay satellite
  port: <svg {...S}><rect x="26" y="26" width="12" height="12" rx="2" /><path d="M10 22h14v20H10zM40 22h14v20H40zM24 32h2M38 32h2M32 26v-8" /><circle cx="32" cy="15" r="3" /></svg>,
  // the box: a shield
  fort: <svg {...S}><path d="M32 8l20 8v14c0 13-9 22-20 26-11-4-20-13-20-26V16z" /><path d="M24 32l6 6 12-12" /></svg>,
  // the records: a star catalogue
  archive: <svg {...S}><rect x="14" y="10" width="36" height="44" rx="3" /><path d="M22 20h20M22 28h20M22 36h14" /><path d="M42 42l2 4 4 1-3 3 1 4-4-2-4 2 1-4-3-3 4-1z" /></svg>,
  // the settings: an observatory dome with its telescope
  settings: <svg {...S}><path d="M12 50h40M16 50V38a16 16 0 0 1 32 0v12" /><path d="M30 26l14-14 4 4-14 14z" /><path d="M26 50v-8h12v8" /></svg>,
  // back to the desktop: a ring gate
  gate: <svg {...S}><circle cx="32" cy="32" r="20" /><circle cx="32" cy="32" r="13" /><path d="M32 12v6M32 46v6M12 32h6M46 32h6" /></svg>,
  village: <svg {...S}><circle cx="32" cy="32" r="16" /></svg>,
}

/** A place's picture from a map's set (kind → SVG); a village wears its page's own icon. */
export function Icon({ icons, kind, page }) {
  const set = icons || {}
  const P = page?.Icon
  return (
    <span className="wd-icon">
      {set[kind] || set.village || null}
      {kind === 'village' && P && <span className="wd-icon-own"><P size={18} strokeWidth={1.7} {...(page.props || {})} /></span>}
    </span>
  )
}
