// Text cards: a 小红书 cover and point pages (3:4, 1080×1440), the wide covers of X (16:9) and 公众号 (2.35:1) — HTML
// templates (Plume's), made into PNGs by the workbench's headless browser. The fonts are the machine's: PingFang on a
// Mac, Noto Sans CJK in the box.
import { str, strs } from './platforms.js'

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
/** Escaped, with **key words** in the accent colour. */
const rich = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
const COLOR = /^#[0-9a-f]{3,8}$/i
export const brandOf = b => ({ accent: COLOR.test(b?.accent) ? b.accent : '#d4380d', background: COLOR.test(b?.background) ? b.background : '#fffaf3', signature: str(b?.signature).slice(0, 40) })

const base = b => `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; }
  body { font-family: "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Noto Sans SC", sans-serif; background: ${b.background}; color: #1f1f1f; -webkit-font-smoothing: antialiased; }
  .card { position: relative; width: 100%; height: 100%; overflow: hidden; }
  b { color: ${b.accent}; font-weight: 800; }
  .mark { background: linear-gradient(transparent 62%, ${b.accent}38 62%, ${b.accent}38 92%, transparent 92%); }
  .sig { font-size: 30px; color: #8c8c8c; letter-spacing: 1px; }
  .accent { color: ${b.accent}; }`
const titleSize = (text, sizes, fallback) => sizes.find(([max]) => [...String(text)].length <= max)?.[1] ?? fallback

/** The 3:4 cover. */
export function coverTall({ title, subtitle, signature, pages, brand }) {
  const size = titleSize(title, [[6, 148], [10, 132], [14, 116], [20, 100]], 84)
  return `<style>${base(brand)}
    .cover { padding: 120px 96px 104px; display: flex; flex-direction: column; }
    .bar { width: 88px; height: 14px; background: ${brand.accent}; border-radius: 7px; }
    .main { flex: 1; display: flex; flex-direction: column; justify-content: center; padding-bottom: 80px; }
    h1 { font-size: ${size}px; font-weight: 900; line-height: 1.24; letter-spacing: -1px; text-wrap: balance; }
    .sub { margin-top: 64px; font-size: 46px; line-height: 1.5; color: #595959; font-weight: 500; text-wrap: balance; }
    .foot { display: flex; justify-content: space-between; align-items: flex-end; }
    .swipe { font-size: 32px; font-weight: 600; }
  </style>
  <div class="card cover"><div class="bar"></div>
    <div class="main"><h1><span class="mark">${rich(title)}</span></h1>${subtitle ? `<p class="sub">${rich(subtitle)}</p>` : ''}</div>
    <div class="foot"><span class="sig">${esc(signature)}</span>${pages > 1 ? `<span class="swipe accent">共 ${pages} 页 →</span>` : ''}</div>
  </div>`
}

/** A 3:4 page of points: its number, its heading, its points. */
export function pointsTall({ heading, points, index, total, signature, brand }) {
  const chars = points.join('').length
  const size = chars > 220 ? 36 : chars > 150 ? 40 : chars > 80 ? 46 : 52
  return `<style>${base(brand)}
    .page { padding: 110px 96px; display: flex; flex-direction: column; }
    .no { font-size: 120px; font-weight: 900; line-height: 1; opacity: .9; }
    h2 { margin-top: 28px; font-size: 72px; font-weight: 800; line-height: 1.3; text-wrap: balance; }
    ol { list-style: none; margin-top: 72px; display: flex; flex-direction: column; gap: ${points.length > 5 ? 40 : 56}px; }
    li { position: relative; padding-left: 48px; font-size: ${size}px; line-height: 1.6; color: #262626; }
    li::before { content: ""; position: absolute; left: 0; top: ${size * 0.55}px; width: 18px; height: 18px; border-radius: 50%; background: ${brand.accent}; }
    .foot { margin-top: auto; display: flex; justify-content: space-between; }
  </style>
  <div class="card page"><div class="no accent">${String(index).padStart(2, '0')}</div><h2>${rich(heading)}</h2>
    <ol>${points.map(p => `<li>${rich(p)}</li>`).join('')}</ol>
    <div class="foot"><span class="sig">${esc(signature)}</span><span class="sig">${index + 1} / ${total}</span></div>
  </div>`
}

/** A wide cover (X 16:9, 公众号 2.35:1). */
export function coverWide({ title, subtitle, signature, brand, height }) {
  const size = titleSize(title, [[10, Math.round(height * 0.2)], [18, Math.round(height * 0.16)], [28, Math.round(height * 0.13)]], Math.round(height * 0.11))
  return `<style>${base(brand)}
    .wide { padding: 0 8%; display: flex; flex-direction: column; justify-content: center; border-left: ${Math.round(height * 0.03)}px solid ${brand.accent}; }
    h1 { font-size: ${size}px; font-weight: 900; line-height: 1.25; text-wrap: balance; }
    .sub { margin-top: ${Math.round(height * 0.05)}px; font-size: ${Math.round(size * 0.42)}px; color: #595959; line-height: 1.5; }
    .sig { position: absolute; right: 6%; bottom: 7%; font-size: ${Math.round(height * 0.045)}px; }
  </style>
  <div class="card wide"><h1><span class="mark">${rich(title)}</span></h1>${subtitle ? `<p class="sub">${rich(subtitle)}</p>` : ''}<span class="sig">${esc(signature)}</span></div>`
}

/**
 * The cards one platform's version gets: [{ name, html, width, height, scale? }] — 小红书 a cover and a page per card,
 * X and 公众号 a wide cover. `title`: the run's title, when the version has none for the cover.
 */
export function cardsFor(platform, fields, { brand, signature, title = '' }) {
  const b = brandOf(brand), sig = signature || b.signature
  if (platform === 'xhs') {
    const cards = (fields.cards || []).filter(c => c.heading || strs(c.points).length)
    const total = 1 + cards.length
    return [
      { name: 'xhs-01.png', html: coverTall({ title: fields.cover?.title || fields.title || title, subtitle: fields.cover?.subtitle || '', signature: sig, pages: total, brand: b }), width: 1080, height: 1440 },
      ...cards.map((c, i) => ({ name: `xhs-${String(i + 2).padStart(2, '0')}.png`, html: pointsTall({ heading: c.heading, points: strs(c.points), index: i + 1, total, signature: sig, brand: b }), width: 1080, height: 1440 })),
    ]
  }
  if (platform === 'x') return [{ name: 'x-cover.png', html: coverWide({ title: strs(fields.tweets)[0]?.split(/[。！？.!?\n]/)[0]?.slice(0, 40) || title, subtitle: '', signature: sig, brand: b, height: 900 }), width: 1600, height: 900 }]
  if (platform === 'wechat_mp') return [{ name: 'wechat_mp-cover.png', html: coverWide({ title: fields.title || title, subtitle: fields.digest || '', signature: sig, brand: b, height: 383 }), width: 900, height: 383, scale: 2 }]
  return []
}
