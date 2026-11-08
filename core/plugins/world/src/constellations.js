// The star map's figures: each place a real constellation, its stars where they are in the sky (right ascension in
// hours, declination in degrees, projected round the figure's middle with north up and east to the left, as one sees
// them), as bright as they are (magnitude) and their own colour (B−V: blue-white to orange-red). Their lines are the
// usual stick figures, drawn faint. The main agent is Polaris with the Little Dipper, the tasks the Big Dipper, a new
// task the Pleiades (young stars), the inbox Lyra (Vega), the workflows Cassiopeia, the agents Orion, the apps Cygnus,
// the connections Gemini, the box the Great Square of Pegasus, the records Leo, the settings the Southern Cross, the way
// back Corona Borealis; another plugin's pages take Scorpius, Taurus, Aquila… in turn. Pure: checked in node (check.mjs).

// a star: [ra (h), dec (°), magnitude, B−V] — B−V 9: a cloud of glowing gas (Orion's nebula), 10: a galaxy (Andromeda's)
export const SKY = {
  ursaMinor: { // Polaris, the Little Dipper: the main agent, the star everything else turns round
    zh: '小熊座', en: 'Ursa Minor', size: 1.15, anchor: 0, bright: 0,
    stars: [[2.530, 89.264, 1.98, 0.60], [17.537, 86.586, 4.36, 0.02], [16.766, 82.037, 4.21, 0.89], [15.734, 77.794, 4.29, 0.04], [16.292, 75.755, 4.95, 0.37], [15.345, 71.834, 3.0, 0.05], [14.845, 74.156, 2.08, 1.47]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 6], [6, 5], [5, 4], [4, 3]],
  },
  bigDipper: { // the Big Dipper (and Alcor by Mizar)
    zh: '北斗七星', en: 'Big Dipper', size: 1.15,
    stars: [[11.062, 61.751, 1.79, 1.07], [11.031, 56.383, 2.37, -0.02], [11.897, 53.695, 2.44, 0.04], [12.257, 57.033, 3.31, 0.08], [12.9, 55.96, 1.77, -0.02], [13.399, 54.925, 2.27, 0.02], [13.792, 49.313, 1.86, -0.19], [13.42, 54.988, 4.01, 0.16]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [3, 4], [4, 5], [5, 6]],
  },
  pleiades: { // the Seven Sisters: young stars in their blue haze
    zh: '昴星团', en: 'Pleiades', size: 0.62,
    stars: [[3.791, 24.105, 2.87, -0.09], [3.819, 24.053, 3.62, -0.08], [3.748, 24.113, 3.7, -0.11], [3.763, 24.368, 3.87, -0.07], [3.772, 23.948, 4.18, -0.06], [3.753, 24.467, 4.3, -0.11], [3.82, 24.137, 5.05, -0.08], [3.743, 24.289, 5.45, -0.04]],
    lines: [],
  },
  lyra: { // Vega and its little parallelogram
    zh: '天琴座', en: 'Lyra', size: 0.8, bright: 0,
    stars: [[18.616, 38.784, 0.03, 0.0], [18.739, 39.67, 4.67, 0.18], [18.746, 37.605, 4.34, 0.19], [18.908, 36.899, 4.3, 1.68], [18.982, 32.69, 3.24, -0.05], [18.835, 33.363, 3.52, 0.0]],
    lines: [[0, 1], [1, 2], [2, 0], [2, 3], [3, 4], [4, 5], [5, 2]],
  },
  cassiopeia: { // the W
    zh: '仙后座', en: 'Cassiopeia', size: 0.95,
    stars: [[0.153, 59.15, 2.27, 0.34], [0.675, 56.537, 2.24, 1.17], [0.945, 60.717, 2.47, -0.15], [1.43, 60.235, 2.68, 0.13], [1.907, 63.67, 3.38, -0.15]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4]],
  },
  orion: { // the hunter: red Betelgeuse, blue Rigel, the belt, and the nebula in his sword
    zh: '猎户座', en: 'Orion', size: 1.12,
    stars: [[5.919, 7.407, 0.5, 1.85], [5.419, 6.35, 1.64, -0.22], [5.585, 9.934, 3.39, -0.16], [5.533, -0.299, 2.23, -0.22], [5.604, -1.202, 1.69, -0.18], [5.679, -1.943, 1.77, -0.21], [5.796, -9.67, 2.09, -0.17], [5.242, -8.202, 0.13, -0.03], [5.588, -5.39, 3.2, 9]],
    lines: [[2, 0], [2, 1], [0, 1], [0, 5], [1, 3], [3, 4], [4, 5], [5, 6], [3, 7]],
  },
  cygnus: { // the swan, the Northern Cross
    zh: '天鹅座', en: 'Cygnus', size: 1.05,
    stars: [[20.69, 45.28, 1.25, 0.09], [20.37, 40.257, 2.23, 0.67], [20.77, 33.97, 2.48, 1.03], [19.75, 45.131, 2.87, -0.03], [19.512, 27.96, 3.08, 1.13], [19.938, 35.083, 3.89, 1.02], [21.216, 30.227, 3.21, 0.99]],
    lines: [[0, 1], [1, 5], [5, 4], [3, 1], [1, 2], [2, 6]],
  },
  gemini: { // the twins, Castor and Pollux
    zh: '双子座', en: 'Gemini', size: 1.0,
    stars: [[7.577, 31.888, 1.58, 0.03], [7.755, 28.026, 1.14, 1.0], [7.186, 30.245, 4.41, 1.26], [6.732, 25.131, 2.98, 1.4], [6.383, 22.514, 2.88, 1.64], [7.74, 24.398, 3.57, 0.93], [7.335, 21.982, 3.53, 0.34], [6.629, 16.399, 1.93, 0.0], [7.068, 20.57, 3.79, 0.79]],
    lines: [[0, 1], [0, 2], [2, 3], [3, 4], [1, 5], [1, 6], [6, 8], [8, 7]],
  },
  pegasus: { // the Great Square, and the neck to Enif
    zh: '飞马座大四边形', en: 'Great Square of Pegasus', size: 1.05,
    stars: [[0.14, 29.091, 2.06, -0.11], [23.063, 28.083, 2.42, 1.67], [23.079, 15.205, 2.49, -0.04], [0.221, 15.184, 2.83, -0.23], [22.691, 10.831, 3.4, -0.09], [21.736, 9.875, 2.38, 1.52]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 0], [2, 4], [4, 5]],
  },
  leo: { // the lion: the sickle and Regulus, Denebola at the tail
    zh: '狮子座', en: 'Leo', size: 1.15,
    stars: [[10.14, 11.967, 1.35, -0.11], [10.122, 16.763, 3.48, -0.03], [10.333, 19.842, 2.08, 1.13], [10.278, 23.417, 3.43, 0.31], [9.879, 26.007, 3.88, 1.22], [9.764, 23.774, 2.98, 0.8], [11.235, 20.524, 2.56, 0.12], [11.237, 15.43, 3.33, -0.01], [11.818, 14.572, 2.14, 0.09]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [2, 6], [6, 8], [8, 7], [7, 0], [6, 7]],
  },
  crux: { // the Southern Cross
    zh: '南十字座', en: 'Crux', size: 0.78,
    stars: [[12.443, -63.099, 0.77, -0.24], [12.795, -59.689, 1.25, -0.23], [12.519, -57.113, 1.59, 1.59], [12.252, -58.749, 2.79, -0.23], [12.356, -60.401, 3.59, 1.42]],
    lines: [[0, 2], [1, 3]],
  },
  coronaBorealis: { // the northern crown: an arc, a way through
    zh: '北冕座', en: 'Corona Borealis', size: 0.8,
    stars: [[15.549, 31.359, 4.14, -0.13], [15.464, 29.106, 3.66, 0.28], [15.578, 26.715, 2.21, -0.02], [15.713, 26.296, 3.81, 0.0], [15.827, 26.068, 4.59, 0.79], [15.96, 26.878, 4.13, 1.23], [16.024, 29.851, 4.98, -0.06]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  },
  scorpius: { // the scorpion: red Antares, the long curled tail
    zh: '天蝎座', en: 'Scorpius', size: 1.2,
    stars: [[16.091, -19.806, 2.62, -0.07], [16.006, -22.622, 2.29, -0.12], [15.981, -26.114, 2.89, -0.19], [16.353, -25.593, 2.89, 0.13], [16.49, -26.432, 1.06, 1.83], [16.598, -28.216, 2.82, -0.25], [16.836, -34.293, 2.29, 1.15], [16.864, -38.048, 3.0, -0.2], [16.91, -42.362, 3.62, 1.37], [17.203, -43.239, 3.32, 0.4], [17.622, -42.998, 1.86, 0.4], [17.793, -40.127, 2.99, 0.51], [17.708, -39.03, 2.41, -0.22], [17.56, -37.104, 1.62, -0.22]],
    lines: [[0, 1], [1, 2], [1, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13]],
  },
  taurus: { // the bull: the Hyades' V, Aldebaran its eye, the long horns
    zh: '金牛座', en: 'Taurus', size: 1.05,
    stars: [[4.599, 16.509, 0.86, 1.54], [4.478, 15.871, 3.4, 0.18], [4.33, 15.628, 3.65, 0.99], [4.382, 17.543, 3.76, 0.98], [4.477, 19.18, 3.53, 1.01], [5.438, 28.608, 1.65, -0.13], [5.627, 21.143, 3.0, -0.19], [4.011, 12.49, 3.47, -0.12]],
    lines: [[2, 3], [3, 4], [4, 5], [2, 1], [1, 0], [0, 6], [2, 7]],
  },
  aquila: { // the eagle: Altair between its two
    zh: '天鹰座', en: 'Aquila', size: 0.95,
    stars: [[19.846, 8.868, 0.76, 0.22], [19.771, 10.613, 2.72, 1.52], [19.922, 6.407, 3.71, 0.86], [19.425, 3.115, 3.36, 0.32], [19.09, 13.863, 2.99, 0.01], [19.104, -4.882, 3.43, -0.09], [20.188, -0.821, 3.23, -0.07]],
    lines: [[1, 0], [0, 2], [0, 3], [3, 5], [3, 4], [0, 6]],
  },
  canisMajor: { // the great dog: Sirius, the brightest star of the night
    zh: '大犬座', en: 'Canis Major', size: 1.0,
    stars: [[6.752, -16.716, -1.46, 0.0], [6.378, -17.956, 1.98, -0.24], [7.14, -26.393, 1.84, 0.68], [6.977, -28.972, 1.5, -0.21], [7.402, -29.303, 2.45, -0.08], [7.05, -23.833, 3.02, -0.08], [6.338, -30.063, 3.02, -0.19]],
    lines: [[1, 0], [0, 5], [5, 2], [2, 3], [2, 4], [3, 6]],
  },
  bootes: { // the herdsman's kite and orange Arcturus
    zh: '牧夫座', en: 'Boötes', size: 1.05,
    stars: [[14.261, 19.182, -0.05, 1.23], [14.75, 27.074, 2.37, 0.97], [15.258, 33.315, 3.46, 0.95], [15.032, 40.39, 3.49, 0.97], [14.535, 38.308, 3.04, 0.19], [14.531, 30.371, 3.57, 1.3], [13.911, 18.398, 2.68, 0.58]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [5, 0], [0, 6]],
  },
  perseus: { // the hero, and Algol
    zh: '英仙座', en: 'Perseus', size: 1.05,
    stars: [[3.405, 49.861, 1.79, 0.48], [3.136, 40.956, 2.12, -0.05], [3.08, 53.506, 2.93, 0.7], [3.715, 47.788, 3.01, -0.13], [3.964, 40.01, 2.89, -0.18], [3.902, 31.884, 2.85, 0.27], [2.845, 55.896, 3.76, 1.68]],
    lines: [[6, 2], [2, 0], [0, 3], [3, 4], [4, 5], [0, 1]],
  },
  auriga: { // the charioteer's pentagon and golden Capella
    zh: '御夫座', en: 'Auriga', size: 1.0,
    stars: [[5.278, 45.998, 0.08, 0.8], [5.992, 44.948, 1.9, 0.08], [5.995, 37.213, 2.62, -0.08], [5.438, 28.608, 1.65, -0.13], [4.95, 33.166, 2.69, 1.53], [5.033, 43.823, 2.99, 0.54], [5.109, 41.234, 3.17, -0.18]],
    lines: [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 5], [5, 6]],
  },
  andromeda: { // the chained princess, and the galaxy beside her
    zh: '仙女座', en: 'Andromeda', size: 1.05,
    stars: [[0.14, 29.091, 2.06, -0.11], [0.656, 30.861, 3.27, 1.28], [1.162, 35.621, 2.07, 1.58], [2.065, 42.33, 2.1, 1.37], [0.946, 38.499, 3.86, 0.13], [0.83, 41.079, 4.53, -0.15], [0.712, 41.269, 3.4, 10]],
    lines: [[0, 1], [1, 2], [2, 3], [2, 4], [4, 5]],
  },
}
/** Which constellation each kind of place is; another plugin's pages (villages) take VILLAGE_SKY in turn. */
export const PLACE_SKY = {
  capital: 'ursaMinor', harbor: 'bigDipper', launch: 'pleiades', post: 'lyra', library: 'cassiopeia', guild: 'orion',
  workshop: 'cygnus', port: 'gemini', fort: 'pegasus', archive: 'leo', settings: 'crux', gate: 'coronaBorealis',
}
export const VILLAGE_SKY = ['scorpius', 'taurus', 'aquila', 'canisMajor', 'bootes', 'perseus', 'auriga', 'andromeda']
export const LIMIT = { stars: 128, lines: 128 }

/**
 * A constellation's stars as seen: [[x, y, magnitude, B−V]] round its middle (or round its `anchor` star), the farthest
 * at distance 1; north up, east to the left (gnomonic projection, so the shapes are true).
 */
export function project(c) {
  const vec = ([ra, dec]) => { const a = ra / 12 * Math.PI, d = dec / 180 * Math.PI; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)] }
  const vs = c.stars.map(vec), dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const sum = vs.reduce((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0]), ln = Math.hypot(...sum)
  const mid = sum.map(x => x / ln)
  // east: the pole × the middle; north: the middle × east
  let east = [-mid[1], mid[0], 0]; const le = Math.hypot(...east) || 1; east = east.map(x => x / le)
  const north = [mid[1] * east[2] - mid[2] * east[1], mid[2] * east[0] - mid[0] * east[2], mid[0] * east[1] - mid[1] * east[0]]
  const xy = vs.map(v => { const k = dot(v, mid); return [-dot(v, east) / k, dot(v, north) / k] })
  let cx, cy
  if (c.anchor != null) [cx, cy] = xy[c.anchor]
  else {
    const xs = xy.map(p => p[0]), ys = xy.map(p => p[1])
    cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2
  }
  const far = Math.max(...xy.map(([x, y]) => Math.hypot(x - cx, y - cy))) || 1
  return xy.map(([x, y], i) => [(x - cx) / far, (y - cy) / far, c.stars[i][2], c.stars[i][3]])
}
/** How big a star is drawn for its magnitude (Sirius the largest, the faintest one can see the smallest). */
export const sizeOf = mag => Math.min(2.4, Math.max(0.45, 2.1 - 0.33 * mag))

/**
 * The figures for these places (world units): { stars: [[x, y, size, B−V]], lines: [[x1, y1, x2, y2]], radius: { id: r } }
 * — at most LIMIT of each (the scene's uniforms). The clock has none. `r`: a figure's radius (times its `size`).
 */
export function figuresOf(places, { r = 0.1, sky = SKY } = {}) {
  const stars = [], lines = [], radius = {}
  let v = 0
  for (const pl of places) {
    const id = pl.kind === 'village' ? VILLAGE_SKY[v++ % VILLAGE_SKY.length] : PLACE_SKY[pl.kind]
    const c = sky[id]
    if (!c) continue
    const pts = project(c), R = r * (c.size || 1)
    if (stars.length + pts.length > LIMIT.stars || lines.length + c.lines.length > LIMIT.lines) continue
    radius[pl.id] = R
    const at = ([x, y]) => [pl.x + x * R, pl.y + y * R]
    pts.forEach(([x, y, mag, bv], i) => stars.push([...at([x, y]), sizeOf(mag) * (i === c.bright && pl.kind === 'capital' ? 1.3 : 1), bv]))
    for (const [a, b] of c.lines) lines.push([...at(pts[a]), ...at(pts[b])])
  }
  return { stars, lines, radius }
}
/** The figures as the scene's uniforms (uCS, uCL). */
export function figureUniforms({ stars, lines }) {
  const uCS = new Float32Array(LIMIT.stars * 4), uCL = new Float32Array(LIMIT.lines * 4)
  stars.forEach((s, i) => uCS.set(s, i * 4))
  lines.forEach((l, i) => uCL.set(l, i * 4))
  return { uCS, uCL }
}
