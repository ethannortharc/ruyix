import { MARK_SVG } from '../mark.js'

const src = `data:image/svg+xml,${encodeURIComponent(MARK_SVG)}`

/** Use the same vector as the sign-in page and favicon at every size. */
export function Mark({ size = 20 }) {
  return <img src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
