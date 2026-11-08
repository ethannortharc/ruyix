// The two maps as scenes for the shell's wallpaper engine (createWallpaper(canvas, { scenes })): drawn in world units
// (uV: the view — the world point at the screen's centre and the world height a screen shows), with the places (uMark:
// x, y, how much land round it, its kind; uMarkB: the pointer on it, something waits there, its figure's reach, there), the tasks (uTask / uTaskB), the
// agents (uStar / uStarB) and the messages between them (uLink / uLinkB) — what world.jsx gives each frame.

import { isleAtlas, CELLS } from './islands.js'

const DATA = `
uniform vec4 uTask[8], uTaskB[8], uStar[16], uStarB[16], uLink[8], uLinkB[8], uMark[24], uMarkB[24]; uniform vec3 uN, uV;
float ink(float d, float w){ return exp(-pow(d / w, 2.0)); }
float segD(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float u = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0); return length(p - a - ab * u); }
// the mainland: the land round the places that have some, joined smoothly, its shore uneven (> 0 on land)
float mainland(vec2 w){
  float sum = 0.0;
  for (int i = 0; i < 24; i++) { vec4 M = uMark[i]; if (uMarkB[i].w < 0.5 || M.z <= 0.0) continue; sum += exp((M.z - length(w - M.xy)) / 0.07); }
  return 0.07 * log(max(sum, 1e-9)) + 0.1 * fbm3(w * 2.1 + 3.0) + 0.03 * fbm3(w * 7.0 + 1.0);
}
// how far the nearest place is (the land's drawings keep clear of them)
float nearPlace(vec2 w){ float d = 9.0; for (int i = 0; i < 24; i++) { if (uMarkB[i].w < 0.5) continue; d = min(d, length(w - uMark[i].xy)); } return d; }
`

// ── the old map: an archipelago on old paper — each place its own island, in relief (lit from the upper left), the
// tasks' islands among them; sea routes from the capital; a double frame round the sheet ──
const ATLAS = {
  data: true, derivatives: true, fps: 20, tone: 'light', c: ['#ecdfbd', '#c9cd98', '#33281c', '#b0352a'],
  tex: { uIsle: isleAtlas }, // the real islands' distances (islands.js)
  fn: `${DATA}
// a real island (islands.js): its shore from the picture of distances (cell: 1-based), past its cell further out at sea,
// and a little finer along the coast than the data; > 0 on land, in world units
float realIsle(vec2 w, vec2 at, float R, float cell){
  vec2 q = (w - at) / R, qc = clamp(q, vec2(-${(CELLS.q - 0.05).toFixed(2)}), vec2(${(CELLS.q - 0.05).toFixed(2)}));
  float c = cell - 1.0, cx = mod(c, ${CELLS.cols.toFixed(1)}), cy = floor(c / ${CELLS.cols.toFixed(1)});
  vec2 uv = vec2((cx + qc.x / ${(2 * CELLS.q).toFixed(1)} + 0.5) / ${CELLS.cols.toFixed(1)}, 1.0 - (cy + 0.5 - qc.y / ${(2 * CELLS.q).toFixed(1)}) / ${CELLS.rows.toFixed(1)});
  float sd = (texture2D(uIsle, uv).r - 0.5) * ${(2 * CELLS.d).toFixed(2)} - length(q - qc);
  float near = 1.0 - smoothstep(0.05, 0.14, abs(sd));
  if (near > 0.0) sd += near * (0.014 * n2(q * 24.0 + cell * 7.3) + 0.006 * n2(q * 61.0 + cell));
  return sd * R;
}
vec3 kindCol(float k){ return k < 0.5 ? vec3(0.78, 0.38, 0.16) : k < 1.5 ? vec3(0.16, 0.42, 0.62) : k < 2.5 ? vec3(0.42, 0.3, 0.62) : k < 3.5 ? vec3(0.4, 0.42, 0.44) : vec3(0.72, 0.2, 0.14); }
// old paper: its colour, foxing, fibres, two folds
vec3 paper(vec2 w){
  vec3 c = uA * (0.95 + 0.07 * fbm3(w * 0.8 + 3.0));
  c *= 1.0 - 0.09 * smoothstep(0.15, 0.6, fbm3(w * 2.0 + 9.0));
  float fox = smoothstep(0.62, 0.8, fbm3(w * 5.5 + 21.0));
  c = mix(c, c * vec3(0.86, 0.74, 0.58), fox * 0.35);
  c *= 0.975 + 0.035 * n2(w * vec2(380.0, 26.0)) + 0.015 * n2(w * vec2(30.0, 420.0));
  // laid paper: fine lines one way, the chain lines further apart the other
  c *= 1.0 - 0.012 * smoothstep(0.6, 1.0, abs(sin(w.y * 520.0))) - 0.02 * smoothstep(0.92, 1.0, abs(sin(w.x * 21.0)));
  // two old water stains: a tide line round each, a little browner inside
  for (int k = 0; k < 2; k++) {
    vec2 o = w - (k == 0 ? vec2(-0.86, -0.62) : vec2(1.32, 0.42)); float r = length(o * vec2(1.0, 1.25)) + 0.03 * fbm3(w * 9.0 + float(k) * 4.0), R = k == 0 ? 0.2 : 0.14;
    c = mix(c, c * vec3(0.9, 0.82, 0.68), smoothstep(R, R - 0.03, r) * 0.18 + exp(-pow((r - R) / 0.006, 2.0)) * 0.22);
  }
  return c;
}
// how far inside an ellipse (radii e) a point d is, in its own units (Inigo Quilez's approximation; > 0 inside) — true to
// distance all round, so the coast's noise moves every shore alike
float inEllipse(vec2 d, vec2 e){ float k0 = length(d / e), k1 = length(d / (e * e)); return -k0 * (k0 - 1.0) / max(k1, 1e-4); }
float smax(float a, float b, float k){ float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }
// an island: > 0 on land (in world units). Each its own shape, from its seed: a heart round the place and a few lobes
// joined smoothly — strung out in a long chain, or spread round into a broad land with arms (the capital one more: a
// land of its own) — sometimes a great bay bitten out of one side, a coast ragged at several scales, islets off it.
// \`wild\`: how far it may stray from round (a task's island keeps closer: its stations go round it)
float isle(vec2 w, vec2 at, float R, float seed, float wild){
  vec2 q = (w - at) / R;
  // far off: the open sea, falling away smoothly (the shore is measured by f's slope: no seam where the island stops)
  float lq = length(q), far = 0.8 - lq;
  if (lq > 2.6) return far * R;
  float h0 = hash(vec2(seed, 1.3)), h1 = hash(vec2(seed, 2.7)), h2 = hash(vec2(seed, 4.1));
  float a = h0 * 6.2831853, ca = cos(a), sa = sin(a);
  q = mat2(ca, -sa, sa, ca) * q;
  vec2 wq = q + (0.15 + 0.14 * wild) * vec2(n2(q * 1.2 + seed), n2(q * 1.2 + seed + 5.2));
  float m = 0.78 - length(wq * vec2(1.0, 1.0 + 0.35 * wild)), chain = step(h1, 0.4);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    if (k == 3 && R < 0.16) break;
    float hk = hash(vec2(seed, fk + 7.0)), hj = hash(vec2(seed, fk + 11.0));
    float th = chain > 0.5 ? h2 * 6.2831853 + (hj - 0.5) * 0.9 + mod(fk, 2.0) * 3.14159 : h2 * 6.2831853 + fk * 2.1 + hj * 1.2;
    vec2 cc = vec2(cos(th), sin(th)) * (0.5 + 0.3 * hk + chain * floor(fk * 0.5) * 0.35) * wild;
    vec2 e = vec2(0.3 + 0.38 * hj, 0.18 + 0.24 * hk) * mix(0.8, 1.0, wild);
    float an = th + (hj - 0.5) * 1.8, cb = cos(an), sb = sin(an);
    vec2 d = mat2(cb, sb, -sb, cb) * (wq - cc);
    m = smax(m, inEllipse(d, e), 0.2);
  }
  if (h1 > 0.62 && wild > 0.5) { vec2 bc = vec2(cos(h2 * 19.0), sin(h2 * 19.0)) * 1.02; m = min(m, length(wq - bc) - 0.5); }
  // the coast's raggedness only near it (well out at sea it cannot reach the shore: the noise fades out, unspent)
  float rag = smoothstep(-0.75, -0.45, m), coast = m;
  if (rag > 0.0) coast += rag * ((0.12 + 0.1 * wild) * fbm3(wq * 2.4 + seed * 1.3) + 0.05 * n2(wq * 6.0 + seed) + 0.028 * n2(wq * 15.0 + seed));
  // islets off its shore: a few, each its own size and lie
  for (int k = 0; k < 3; k++) {
    float fk = float(k), hk = hash(vec2(seed, fk + 21.0)), hj = hash(vec2(seed, fk + 51.0));
    if (hk < 0.45 * (2.0 - wild)) continue;
    float th = hash(vec2(seed, fk + 31.0)) * 6.2831853, an = hj * 3.14159, cb = cos(an), sb = sin(an);
    vec2 ic = vec2(cos(th), sin(th)) * (1.15 + 0.55 * hash(vec2(seed, fk + 41.0)));
    vec2 e = vec2(0.06 + 0.09 * hk, 0.045 + 0.035 * hj), d = mat2(cb, sb, -sb, cb) * (wq - ic); // never so thin the noise sinks it (a drowned sliver drew two stray coast lines)
    float il = inEllipse(d, e);
    if (il + 0.02 > coast) coast = max(coast, il + 0.015 * n2(wq * 14.0 + fk * 3.0)); // (where it cannot rise above the sea: unspent)
  }
  return mix(coast, far, smoothstep(2.3, 2.6, lq)) * R; // (the land reaches at most about 2.3)
}
// its height: a dome, broken into hills and a ridge or two
float height(vec2 w, vec2 at, float R, float f, float seed){
  vec2 q = (w - at) / R;
  float dome = smoothstep(0.0, R * 0.6, f);
  float hills = 0.45 + 0.55 * fbm3(q * 2.1 + seed * 3.1) + 0.45 * pow(1.0 - abs(n2(q * 2.8 + seed)), 3.0);
  return dome * hills;
}`,
  body: `// the old map: a world one looks round
    vec2 w = p * uV.z + uV.xy; float px = max(uP, 0.5) / uR.y * uV.z;
    vec3 inkC = uC;
    col = paper(w);
    // the folds of the sheet: a crease, light on one side and shadowed on the other
    for (int k = 0; k < 3; k++) {
      float fx = k == 0 ? -0.58 : k == 1 ? 0.58 : 0.0;
      float d = k < 2 ? w.x - fx : w.y - 0.02;
      col *= 1.0 - 0.05 * exp(-pow(d / (px * 3.0), 2.0)) + 0.025 * exp(-pow((d - px * 4.0) / (px * 3.0), 2.0));
    }
    col = mix(col, inkC, clamp(ink(abs(fract(w.x * 2.0) - 0.5) - 0.5, px * 2.0 * 0.6) + ink(abs(fract(w.y * 2.0) - 0.5) - 0.5, px * 2.0 * 0.6), 0.0, 1.0) * 0.07);
    // the islands: the places' and the tasks'; the highest ground where they meet decides
    float f = -1.0, h = 0.0, which = -1.0, fog = 0.0;
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i], MB = uMarkB[i]; if (MB.w < 0.5 || M.z <= 0.0) continue;
      float seed = float(i) * 5.37 + 2.0, fi;
      if (MB.z > 0.5) fi = realIsle(w, M.xy, M.z, MB.z); // a real island: one texture fetch, so everywhere (no edge where it stops)
      else fi = isle(w, M.xy, M.z, seed, 1.0); // (one of its own, should a place have no real one)
      if (fi > f) { f = fi; which = float(i); h = fi > 0.0 ? height(w, M.xy, M.z, fi, seed) : 0.0; fog = 0.0; }
    }
    // (a scheduled task's fog: only on and right by its island, not the open sea round it)
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i]; float seed = float(i) * 7.13 + 31.0, fi = isle(w, T.xy, T.z * 1.18, seed, 0.4);
      if (fi > f) { f = fi; which = 30.0 + float(i); h = fi > 0.0 ? height(w, T.xy, T.z * 1.18, fi, seed) * 0.8 : 0.0; fog = T.w > 2.5 && T.w < 3.5 ? smoothstep(-0.06, -0.01, fi) : 0.0; }
    }
    // the light comes from the upper left: a slope facing it is bright, the far one in shade
    vec3 nrm = normalize(vec3(-dFdx(h) / px * 0.075, -dFdy(h) / px * 0.075, 1.0));
    vec3 sun = normalize(vec3(-0.6, 0.65, 0.55));
    float lit = dot(nrm, sun);
    vec2 gf = vec2(dFdx(f), dFdy(f)); float gfl = max(length(gf), 1e-9);
    float fd = f / max(gfl * uR.y / uV.z, 0.05); // how far the shore is (world units), even however the coast bends: its lines
    float fs = min(fd, f); // the water's: never reaching further out than either
    if (f < 0.0) {
      // the sea: green shallows along the shores; on the side away from the light, the island's shadow on the water
      float near = exp(fs / (px * 30.0));
      col = mix(col, vec3(0.56, 0.7, 0.64), 0.3 * near * (1.0 - fog * 0.7));
      float away = clamp(dot(-gf / gfl, -normalize(sun.xy)), 0.0, 1.0);
      col *= 1.0 - 0.3 * exp(fs / (px * 16.0)) * pow(away, 0.7) * (1.0 - fog);
      col = mix(col, inkC, ink(abs(fract(-fs / (px * 7.0)) - 0.5) - 0.5, 0.18) * exp(fs / (px * 16.0)) * 0.2 * (1.0 - fog * 0.6));
      // the open sea deeper: a faint grey-green wash, blotchy as watercolour, deepening away from the shores; two dotted
      // depth lines (soundings) following the shores
      float deep = smoothstep(-0.03, -0.24, fs);
      col = mix(col, vec3(0.58, 0.66, 0.65) * (0.94 + 0.12 * fbm3(w * 1.6 + 5.0)), 0.16 * deep * (1.0 - fog));
      float iso = ink(abs(fs + 0.05), px * 0.6) + ink(abs(fs + 0.1), px * 0.6) * 0.7;
      col = mix(col, inkC, iso * step(0.5, fract((w.x * 0.8 + w.y) / (px * 5.0))) * 0.2 * (1.0 - fog));
    } else {
      // land: green and ochre washes, warmer where lit, cooler in shade; contour lines; woods on the gentle ground
      float ochre = step(0.5, hash(vec2(which, 3.7))) * (0.6 + 0.3 * hash(vec2(which, 9.1))); // about half the islands ochre, the rest green
      vec3 ground = mix(mix(uB, vec3(0.84, 0.72, 0.48), max(ochre * 0.85, smoothstep(-0.2, 0.4, fbm3(w * 1.7 + which * 3.0)) * 0.5)), uA, 0.1 + 0.16 * 0.7 * n2(w * 3.0));
      ground = mix(ground, vec3(0.88, 0.82, 0.64), smoothstep(0.6, 1.05, h) * 0.65); // the heights: bare and pale
      vec3 shade = mix(vec3(0.42, 0.45, 0.54), vec3(1.13, 1.07, 0.93), smoothstep(-0.15, 0.95, lit));
      col = mix(col, ground * shade, fog > 0.5 ? 0.3 : 0.88);
      if (fog > 0.5) col = mix(col, inkC, 0.07 * step(0.6, fract((w.x + w.y) / px / 6.0)));
      else {
        float lv = h * 7.0, cl = abs(fract(lv) - 0.5) / max(fwidth(lv), 1e-5);
        col = mix(col, inkC, (1.0 - smoothstep(0.0, 1.1, cl)) * 0.16 * smoothstep(0.02, 0.1, h));
        // hachures on the steep shade side: short strokes down the slope
        float steep = smoothstep(0.004, 0.02, length(vec2(dFdx(h), dFdy(h))) / px * 0.0025) * smoothstep(0.3, -0.3, lit);
        vec2 dn = normalize(vec2(dFdx(h), dFdy(h)) + 1e-9), across = vec2(-dn.y, dn.x);
        col = mix(col, inkC, steep * step(0.62, fract(dot(w, across) / (px * 4.0))) * 0.22);
        // woods: round trees on the low gentle ground
        vec2 g = w * 26.0, cell = floor(g), u = fract(g);
        float hm = hash(cell + which);
        if (hm > 0.62 && h > 0.08 && h < 0.45 && nearPlace(w) > 0.1) {
          for (int k = 0; k < 2; k++) {
            vec2 tc = vec2(0.3 + 0.4 * float(k), 0.35 + 0.3 * hash(cell + float(k)));
            float tr = length(u - tc) / 26.0, rr = px * (2.6 + 1.2 * hash(cell + float(k) + 5.0));
            col = mix(col, vec3(0.36, 0.47, 0.27) * (0.85 + 0.25 * smoothstep(-0.2, 0.8, lit)), smoothstep(rr, rr - px, tr) * 0.8);
            col = mix(col, inkC, ink(tr - rr, px * 0.75) * 0.6);
          }
        }
      }
    }
    // the shore stands up: a bright rim where it faces the light, a dark one where it turns away; then a firm ink line,
    // a finer one just off it
    float facing = dot(-gf / gfl, normalize(sun.xy));
    if (fog < 0.5) col = mix(col, facing > 0.0 ? vec3(1.0, 0.97, 0.88) : vec3(0.25, 0.2, 0.15), ink(fd - px * 3.0, px * 2.2) * abs(facing) * 0.35 * step(-px * 6.0, fd));
    col = mix(col, inkC, clamp(ink(fd, px * (fog > 0.5 ? 0.9 : 1.5)) * (fog > 0.5 ? step(0.5, fract(atan(gf.y, gf.x) * 9.0)) * 0.6 : 0.95) + ink(fd + px * 4.5, px * 0.7) * 0.45 * (1.0 - fog), 0.0, 1.0));
    float landSeen = smoothstep(-px * 30.0, 0.0, fs);
    // the island the pointer is on: a third line round its coast, a little way out
    for (int i = 0; i < 24; i++) if (uMarkB[i].x > 0.5 && abs(which - float(i)) < 0.5) col = mix(col, inkC, ink(fd + px * 10.0, px * 1.0) * 0.4);
    // something waits for the person on an island: a vermilion ring round its coast, breathing; work done and not
    // looked at (the records' island): a soft green one
    for (int i = 0; i < 24; i++) {
      float y = uMarkB[i].y; if (y < 0.5 || abs(which - float(i)) > 0.5) continue;
      vec3 ringC = y < 1.5 ? uD : vec3(0.24, 0.5, 0.28);
      float breath = y < 1.5 ? 0.6 + 0.3 * sin(t * 2.4) : 0.62 + 0.18 * sin(t * 1.2);
      // a firm ring a little way out and a dotted one beyond it, as a mapmaker marks a place
      col = mix(col, ringC, ink(fd + px * 14.0, px * 1.5) * breath);
      col = mix(col, ringC, ink(fd + px * 21.0, px * 1.1) * step(0.5, fract(atan(gf.y, gf.x) * 12.0)) * breath * 0.8);
    }
    // sea routes: from the capital to each other island, dotted, on the water
    vec2 cap = uMark[0].xy;
    for (int i = 1; i < 24; i++) {
      vec4 M = uMark[i]; if (uMarkB[i].w < 0.5 || M.z <= 0.0) continue;
      vec2 a = cap, b = M.xy, ab = b - a; float L = length(ab); vec2 nrm2 = vec2(-ab.y, ab.x) / max(L, 1e-6);
      float u = clamp(dot(w - a, ab) / max(L * L, 1e-9), 0.0, 1.0);
      vec2 c = a + ab * u + nrm2 * sin(u * 3.14159) * L * 0.1;
      col = mix(col, inkC, ink(length(w - c), px * 1.0) * step(0.55, fract(u * L / (px * 9.0))) * 0.5 * (1.0 - landSeen));
    }
    // the tasks: the road of stations round each island
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i]; float kind = T.w, R = T.z;
      if (kind > 2.5 && kind < 3.5) continue;
      vec2 q = (w - T.xy) / R; float d = length(q);
      float n = max(B.x, 1.0), a = fract(0.25 - atan(q.y, q.x) / 6.2831853);
      float road = ink(abs(d - 0.62) * R, px * 1.1) * (a < B.y / n ? 1.0 : step(0.45, fract(a * n * 7.0)) * 0.7);
      col = mix(col, inkC, road * 0.75);
      for (int k = 0; k < 12; k++) {
        if (float(k) >= n) break;
        float th = (0.25 - (float(k) + 0.5) / n) * 6.2831853;
        vec2 c = T.xy + vec2(cos(th), sin(th)) * 0.62 * R; float r = length(w - c);
        float isCur = abs(float(k) - B.z) < 0.5 ? 1.0 : 0.0, isDone = float(k) < B.y ? 1.0 : 0.0;
        if (isCur > 0.5 && kind > 4.5) {
          // gone wrong: the station crossed out in red ink
          vec2 dq = abs(mat2(0.7071, 0.7071, -0.7071, 0.7071) * (w - c));
          col = mix(col, vec3(0.62, 0.12, 0.1), smoothstep(px * 1.4, px * 0.4, min(dq.x, dq.y)) * step(max(dq.x, dq.y), px * 7.0) * (0.75 + 0.25 * sin(t * 3.0)));
        } else if (isCur > 0.5 && kind > 1.5 && kind < 2.5) {
          vec2 e = abs(w - c) - vec2(px * 8.0); float box = max(e.x, e.y), pulse = 0.75 + 0.25 * sin(t * 2.4);
          col = mix(col, uD, smoothstep(px, -px, box) * 0.88 * pulse);
          col = mix(col, uA, ink(box + px * 2.5, px * 0.8) * 0.8 * pulse);
        } else if (isCur > 0.5) {
          col = mix(col, uD, smoothstep(px * 5.0, px * 3.5, r));
          col = mix(col, uD, ink(r - px * (6.0 + 9.0 * fract(t * 0.6)), px * 1.0) * (1.0 - fract(t * 0.6)) * 0.7);
        } else {
          col = mix(col, isDone > 0.5 ? inkC : uA, smoothstep(px * 3.8, px * 2.6, r));
          col = mix(col, inkC, ink(r - px * 3.4, px * 0.9) * 0.9);
        }
      }
      if (kind > 3.5 && kind < 4.5) {
        float e = exp(-(t - B.w) * 0.5), sd = length(w - T.xy);
        col = mix(col, uD, (ink(sd - R * 0.34, px * 2.2) + ink(sd - R * 0.27, px * 1.2) + smoothstep(R * 0.1, R * 0.08, sd) * 0.8) * e * 0.9);
      }
      if (abs(float(i) - uN.z) < 0.5) col = mix(col, inkC, ink(d * R - R * 1.32, px * 1.2) * 0.3);
    }
    // the sea's waves, the rhumb lines from the compass, the ship's wake; the pointer on a place
    float wv; { vec2 g = w * vec2(20.0, 36.0); float row = floor(g.y), x = fract(g.x + row * 0.5), y = fract(g.y);
      wv = exp(-pow(abs(y - 0.35 - 0.3 * sqrt(max(0.0, 1.0 - pow(2.0 * x - 1.0, 2.0)))) / (px * 36.0 * 0.9), 2.0)) * step(0.4, hash(vec2(floor(g.x + row * 0.5), row))); }
    col = mix(col, inkC, wv * 0.1 * (1.0 - landSeen));
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i]; vec4 MB = uMarkB[i]; if (MB.w < 0.5) continue;
      vec2 q = w - M.xy; float r = length(q);
      if (abs(M.w - 11.0) < 0.5) {
        float ra = atan(q.y, q.x), rh = abs(fract(ra * 16.0 / 6.2831853 + 0.5) - 0.5) * 6.2831853 / 16.0 * r;
        col = mix(col, inkC, ink(rh, px * 0.7) * 0.06 * smoothstep(0.07, 0.14, r) * (1.0 - landSeen));
        // and from two more roses out at sea, as portolan charts have them (no rose drawn: only their lines)
        for (int k = 0; k < 2; k++) {
          vec2 o = w - (k == 0 ? vec2(-1.28, 0.24) : vec2(1.2, 0.78)); float ro = length(o), ao = atan(o.y, o.x);
          float rl = abs(fract(ao * 16.0 / 6.2831853 + 0.5) - 0.5) * 6.2831853 / 16.0 * ro;
          col = mix(col, k == 0 ? inkC : uD, ink(rl, px * 0.6) * 0.045 * smoothstep(0.02, 0.1, ro) * (1.0 - landSeen));
        }
      }
      if (abs(M.w - 3.0) < 0.5) {
        vec2 v = q + vec2(0.0, px * 6.0); float wake = abs(abs(v.x) * 0.55 + v.y);
        col = mix(col, inkC, ink(wake, px * 1.0) * step(v.y, 0.0) * smoothstep(-0.12, -0.02, v.y) * 0.35 * (0.6 + 0.4 * sin(t * 2.0 + v.y * 80.0)));
      }
    }
    // couriers and banners
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i], M = uLinkB[i]; if (M.y < 0.5) continue;
      vec2 a = L.xy, b = L.zw, ab = b - a; float len2 = max(dot(ab, ab), 1e-9);
      float u = clamp(dot(w - a, ab) / len2, 0.0, 1.0), d = length(w - a - ab * u);
      col = mix(col, inkC, ink(d, px * 0.9) * step(0.5, fract(u * sqrt(len2) / (px * 9.0))) * 0.6);
      col = mix(col, uD, smoothstep(px * 4.5, px * 3.0, length(w - a - ab * fract((t - M.x) * 0.35))));
    }
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i]; vec2 d = w - S.xy; float r = length(d), age = t - S.z; vec3 c = kindCol(S.w);
      if (age < 1.6) col = mix(col, inkC, ink(r - px * (8.0 + age * 28.0), px * 1.2) * (1.0 - age / 1.6) * 0.5);
      vec2 m = d - vec2(0.0, px * 8.0);
      col = mix(col, inkC, ink(m.x, px * 0.8) * step(0.0, m.y) * step(m.y, px * 14.0) * 0.9);
      vec2 fl = d - vec2(0.0, px * 15.0); float wv2 = sin(t * 3.0 + S.x * 40.0) * px * 1.2;
      col = mix(col, c, step(0.0, fl.x) * step(fl.x, px * 11.0) * step(abs(fl.y - wv2 * fl.x / (px * 11.0)), px * 4.0 * (1.0 - fl.x / (px * 12.0))) * 0.95);
      col = mix(col, c, smoothstep(px * 6.0, px * 4.6, r));
      col = mix(col, inkC, ink(r - px * 5.6, px * 1.0));
    }
    // the sheet's edges: browned, and a double frame just inside them (on the screen: the map one looks through)
    vec2 sp = gl_FragCoord.xy / max(uP, 0.5); vec2 sz = uR / max(uP, 0.5);
    float e = min(min(sp.x, sz.x - sp.x), min(sp.y, sz.y - sp.y));
    if (e < 100.0) col *= mix(0.62, 1.0, smoothstep(0.0, 70.0, e + 18.0 * fbm3(p * 9.0))); // the browned edge: only near it
    col = mix(col, inkC, (ink(e - 12.0, 0.9) * 0.75 + ink(e - 17.0, 0.6) * 0.45));`,
}

// ── the star map: real constellations before a great nebula — each place's figure as it is in the sky, its stars as
// bright and as coloured as they are, their lines faint (brighter on the one the pointer is on); no pictures, and the
// names only when one points ──
const SKY = {
  data: true, fps: 24, tone: 'dark', c: ['#020309', '#0e1838', '#6a0f18', '#ffb46a'],
  fn: `${DATA}
uniform vec4 uCS[128], uCL[128]; // the constellations (constellations.js): stars x, y, size, B−V; lines x1, y1, x2, y2
vec3 kindCol(float k){ return k < 0.5 ? vec3(1.0, 0.62, 0.42) : k < 1.5 ? vec3(0.42, 0.8, 1.0) : k < 2.5 ? vec3(0.7, 0.62, 1.0) : k < 3.5 ? vec3(0.66, 0.72, 0.8) : vec3(1.0, 0.72, 0.26); }
// a star's colour from its B−V: hot blue-white, white, yellow, orange, to cool orange-red
vec3 starCol(float bv){
  vec3 c = mix(vec3(0.66, 0.76, 1.0), vec3(0.88, 0.92, 1.0), smoothstep(-0.25, 0.0, bv));
  c = mix(c, vec3(1.0, 0.98, 0.93), smoothstep(0.0, 0.4, bv));
  c = mix(c, vec3(1.0, 0.88, 0.68), smoothstep(0.4, 0.95, bv));
  c = mix(c, vec3(1.0, 0.72, 0.46), smoothstep(0.95, 1.5, bv));
  return mix(c, vec3(1.0, 0.56, 0.36), smoothstep(1.5, 1.85, bv));
}
// the great nebula behind it all, as telescopes show one: clumps and veils of glowing hydrogen (deep red, pinker and
// paler where it is dense), oxygen glowing teal round its hot heart, a second cloud lit blue by its stars, threads of
// bright gas, and dark dust in lanes and knots across it. It breathes: its glow rises and falls slowly, part by part.
vec3 nebula(vec2 w, float t){
  vec2 q = w * 1.15, drift = vec2(t * 0.003, -t * 0.0018);
  vec2 warp = vec2(fbm3(q * 0.7 + vec2(1.7, 9.2) + drift), fbm3(q * 0.7 + vec2(8.3, 2.8) - drift));
  vec2 qq = q + 0.8 * warp;
  vec2 c1 = (w - vec2(-0.35, 0.08)) * vec2(0.72, 1.05), c2 = (w - vec2(0.98, -0.4)) * vec2(1.0, 1.25);
  float edge = smoothstep(-0.3, 0.45, fbm3(q * 0.9 + 1.8 * warp + 3.0) + 0.25);
  float s1 = exp(-dot(c1, c1) / 0.42) * edge, s2 = 0.85 * exp(-dot(c2, c2) / 0.16) * edge;
  vec3 col = uA + uB * (0.3 + 0.35 * (0.5 + 0.7 * n2(q * 0.45 + 2.0))) * (1.0 - min(s1 + s2, 1.0) * 0.5);
  if (s1 + s2 < 0.015) return col; // the open dark beyond the clouds: only the haze
  float gas = smoothstep(-0.32, 0.62, fbm(qq * 1.5)), fine = 0.6 + 0.8 * (0.5 + 0.7 * n2(qq * 4.5 + 7.0));
  float breathe = 0.84 + 0.16 * sin(t * 0.3 + warp.x * 6.0 + warp.y * 4.0);
  float fade = smoothstep(0.015, 0.09, s1 + s2), d1 = s1 * gas * fine * breathe * fade, d2 = s2 * gas * fine * breathe * fade;
  float fil = s1 + s2 > 0.08 ? pow(1.0 - abs(fbm3(qq * 2.1 + 13.0)), 8.0) * (s1 + s2) * smoothstep(0.08, 0.2, s1 + s2) : 0.0; // (fading in: no seam)
  float heart = fade * exp(-dot(c1 - vec2(0.06, -0.03), c1 - vec2(0.06, -0.03)) / 0.03);
  // the red cloud: deep red, pink where dense, pale at its brightest; teal-white at its heart
  col += uC * 4.2 * d1 + vec3(0.95, 0.3, 0.45) * pow(d1, 2.0) * 1.3 + vec3(1.0, 0.82, 0.8) * pow(d1, 4.0) * 0.9;
  col += mix(vec3(0.1, 0.55, 0.62), vec3(0.75, 0.95, 0.95), heart * gas) * heart * gas * 0.9 * breathe;
  // the blue cloud: starlight on dust
  col += vec3(0.16, 0.3, 0.75) * d2 * 1.5 + vec3(0.55, 0.7, 1.0) * pow(d2, 2.5) * 0.9;
  col += mix(vec3(1.0, 0.45, 0.5), vec3(0.6, 0.75, 1.0), s2 / max(s1 + s2, 1e-3)) * fil * 0.5 * breathe;
  // the dust: dark knots and lanes; a faint bright rim where it thins into the glowing gas
  float knots = smoothstep(0.12, 0.42, fbm3(q * 1.7 + 1.6 * warp + 11.0)), lanes = smoothstep(0.72, 0.95, 1.0 - abs(fbm3(qq * 1.1 - 2.0)) * 1.4);
  float dust = max(knots * 0.8, lanes * 0.6) * smoothstep(0.02, 0.3, s1 + s2);
  col += vec3(1.0, 0.6, 0.5) * smoothstep(0.0, 0.1, knots) * (1.0 - smoothstep(0.1, 0.25, knots)) * d1 * 0.25;
  return col * (1.0 - 0.85 * dust);
}
float starField(vec2 p, float t, float scale, float px, float keep, float big){
  vec2 g = p * scale, i = floor(g), f = fract(g);
  float h = hash(i); if (h < keep) return 0.0;
  float h2 = hash(i + 3.7); vec2 c = 0.3 + 0.4 * hash22(i + 1.3), d = (f - c) / scale;
  float r = length(d), size = px * (0.7 + 1.3 * h2) * big, tw = 0.55 + 0.45 * sin(t * (0.4 + 2.6 * h2) + h2 * 60.0);
  float s = exp(-pow(r / size, 2.0)) + exp(-r / (px * 1.6 * big)) * 0.12;
  return s * tw * (0.35 + 0.9 * h2) * smoothstep(0.5, 0.42, max(abs(f.x - 0.5), abs(f.y - 0.5)));
}`,
  body: `// the star map: a sky one looks round
    vec2 w = p * uV.z + uV.xy; float px = max(uP, 0.5) / uR.y * uV.z, spx = max(uP, 0.5) / uR.y;
    col = nebula(w, t);
    // the countless faint stars: the far ones move less as one looks round (depth); more of them in the nebula's glow
    vec2 far = (w - uV.xy) * 0.7 + uV.xy * 0.5;
    col += vec3(0.85, 0.9, 1.0) * starField(far, t, 70.0 / uV.z, spx, 0.84, 1.0);
    col += vec3(1.0, 0.92, 0.85) * starField(w + 3.1, t, 26.0, px, 0.9, 1.1) * 0.45;
    col += vec3(0.8, 0.88, 1.0) * starField(p + uV.xy * 0.18 + 7.7, t * 0.7, 9.0, spx, 0.9, 1.15) * 0.3;
    // the places: which one the pointer is on, which waits for the person (each with its figure's reach), the main
    // agent's star (Polaris: a soft light round it, livelier as it listens and works), the Pleiades' blue haze
    vec3 hov = vec3(0.0, 0.0, -1.0), waits = vec3(0.0, 0.0, -1.0), unseen = vec3(0.0, 0.0, -1.0); bool nearFig = false;
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i], MB = uMarkB[i]; if (MB.w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      if (MB.z > 0.0 && length(w - M.xy) < MB.z * 1.08 + px * 40.0) nearFig = true; // the figures' loops only near one
      if (MB.x > 0.5) hov = vec3(M.xy, MB.z);
      if (MB.y > 0.5 && MB.y < 1.5) waits = vec3(M.xy, MB.z); // something waits for the person there
      if (MB.y > 1.5) unseen = vec3(M.xy, MB.z); // work done and not looked at (the records)
      vec2 q = w - M.xy; float r = length(q);
      if (M.w < 1.5) col += vec3(1.0, 0.9, 0.72) * (exp(-r / 0.035) * 0.22 + exp(-r / 0.012) * 0.25) * (0.85 + 0.15 * sin(t * 0.7) + 0.8 * uK);
      else if (abs(M.w - 3.0) < 0.5) {
        float g = fbm3(q * 16.0 + vec2(t * 0.02, -t * 0.015)), reach = max(MB.z, 0.05);
        col += vec3(0.32, 0.5, 1.0) * exp(-r / (reach * 0.55)) * (0.16 + 0.3 * max(g, 0.0)) * (0.85 + 0.15 * sin(t * 0.5));
      }
    }
    // the figures' lines: faint, a little apart from their stars as star charts draw them; the one pointed at brighter
    if (nearFig) for (int i = 0; i < 128; i++) {
      vec4 L = uCL[i]; vec2 ab = L.zw - L.xy; float len2 = dot(ab, ab); if (len2 < 1e-12) continue;
      vec2 ap = w - L.xy; float u = clamp(dot(ap, ab) / len2, 0.0, 1.0); vec2 dd = ap - ab * u; float d2 = dot(dd, dd);
      if (d2 > px * px * 16.0) continue;
      float len = sqrt(len2), gapAt = px * 6.0 / len;
      float shown = smoothstep(gapAt, gapAt * 1.6, u) * smoothstep(1.0 - gapAt, 1.0 - gapAt * 1.6, u);
      float on = hov.z > 0.0 && length((L.xy + L.zw) * 0.5 - hov.xy) < hov.z * 1.05 ? 1.0 : 0.0;
      col += vec3(0.6, 0.72, 1.0) * exp(-d2 / (px * px * 0.45)) * mix(0.08, 0.42, on) * shown;
    }
    // the figures' stars: a point, a soft halo, small spikes on the brightest; a smudge for a cloud of gas or a galaxy;
    // amber and pulsing where something waits for the person
    if (nearFig) for (int i = 0; i < 128; i++) {
      vec4 S = uCS[i]; if (S.z <= 0.0) continue;
      vec2 d = w - S.xy; float r2 = dot(d, d), z = S.z, reach = px * 28.0 * z;
      if (r2 > reach * reach) continue;
      float r = sqrt(r2);
      float on = hov.z > 0.0 && length(S.xy - hov.xy) < hov.z * 1.05 ? 1.0 : 0.0;
      float wait = waits.z > 0.0 && length(S.xy - waits.xy) < waits.z * 1.05 ? 1.0 : 0.0;
      if (S.w > 8.5) {
        float gal = step(9.5, S.w), a = 0.65 * gal, ca = cos(a), sa = sin(a);
        vec2 e = (mat2(ca, sa, -sa, ca) * d) / (gal > 0.5 ? vec2(px * 20.0, px * 6.5) : vec2(px * 8.0, px * 9.0));
        vec3 c = gal > 0.5 ? vec3(0.95, 0.9, 0.82) : vec3(1.0, 0.42, 0.55);
        col += c * (exp(-dot(e, e)) * 0.5 + exp(-pow(r / (px * 1.8), 2.0)) * 0.55) * (1.0 + 0.6 * on);
        continue;
      }
      vec3 c = starCol(S.w);
      float pulse = 0.5 + 0.5 * sin(t * 2.4);
      if (wait > 0.5) c = mix(c, vec3(1.0, 0.7, 0.28), 0.8);
      float fresh = unseen.z > 0.0 && length(S.xy - unseen.xy) < unseen.z * 1.05 ? 1.0 : 0.0;
      if (fresh > 0.5) { c = mix(c, vec3(0.55, 1.0, 0.72), 0.55); col += vec3(0.4, 1.0, 0.6) * exp(-r / (px * 10.0 * z)) * 0.12 * (0.7 + 0.3 * sin(t * 1.2)); }
      float tw = 0.86 + 0.14 * sin(t * (1.3 + 0.4 * z) + float(i) * 2.7);
      float k = (1.0 + 0.55 * on) * (wait > 0.5 ? 0.95 + 0.55 * pulse : 1.0) * tw;
      float core = exp(-pow(r / (px * 1.2 * z), 2.0)), halo = exp(-r / (px * 4.5 * z)) * 0.28;
      float spikes = z > 1.55 ? (exp(-abs(d.x) / (px * 0.7)) * exp(-abs(d.y) / (px * 7.0 * z)) + exp(-abs(d.y) / (px * 0.7)) * exp(-abs(d.x) / (px * 7.0 * z))) * 0.16 * (z - 1.4) : 0.0;
      col += c * (core * 2.2 + halo + spikes) * k + vec3(1.0) * core * 0.5 * k;
      if (wait > 0.5) col += vec3(1.0, 0.66, 0.24) * exp(-r / (px * 9.0 * z)) * 0.18 * pulse;
    }
    // the tasks: each a constellation round a faint ring — a star a step, the done ones joined by bright lines, a line
    // of light running from the one at work to the next, the rest dim and dashed
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i];
      vec2 q = w - T.xy; float r = length(q), R = T.z, kind = T.w;
      if (r > R * 1.45 + px * 30.0) continue; // far from its ring
      float hot = abs(float(i) - uN.z) < 0.5 ? 1.0 : 0.0;
      float a = fract(0.25 - atan(q.y, q.x) / 6.2831853), n = max(B.x, 1.0), seg = floor(a * n), within = fract(a * n), gw = min(0.3, 0.012 * n);
      float gap = smoothstep(0.0, gw, within) * smoothstep(1.0, 1.0 - gw, within);
      float line = exp(-pow((r - R) / (px * 1.2), 2.0)), glow = exp(-abs(r - R) / (px * 10.0)), breathe = 0.6 + 0.4 * sin(t * 2.2 + float(i));
      vec3 c = vec3(0.0);
      if (kind > 2.5 && kind < 3.5) c = vec3(0.7, 0.78, 1.0) * line * step(0.55, fract(a * 72.0)) * (0.35 + 0.3 * hot);
      else if (kind > 3.5 && kind < 4.5) { float age = t - B.w, rr = R * (1.0 + age * 0.08); c = vec3(0.45, 1.0, 0.68) * (exp(-pow((r - rr) / (px * 1.6), 2.0)) * 1.4 + exp(-abs(r - rr) / (px * 14.0)) * 0.6) * exp(-age * 1.5); }
      else {
        vec3 now = kind > 4.5 ? vec3(1.0, 0.36, 0.34) : kind > 1.5 ? vec3(1.0, 0.72, 0.28) : vec3(0.72, 0.9, 1.0), lit = mix(uD, vec3(1.0), 0.35);
        c = vec3(0.6, 0.7, 0.95) * line * 0.08; // the faint ring the steps sit on
        for (int k = 0; k < 12; k++) {
          if (float(k) >= n) break;
          float th = (0.25 - (float(k) + 0.5) / n) * 6.2831853, th2 = (0.25 - (float(k) + 1.5) / n) * 6.2831853;
          vec2 sa = T.xy + vec2(cos(th), sin(th)) * R, sb = T.xy + vec2(cos(th2), sin(th2)) * R;
          float isDone = float(k) < B.y ? 1.0 : 0.0, isCur = abs(float(k) - B.z) < 0.5 ? 1.0 : 0.0;
          // the line to the next step (not after the last)
          if (float(k) + 1.0 < n) {
            vec2 ab = sb - sa; float len = length(ab), u = clamp(dot(w - sa, ab) / (len * len), 0.0, 1.0), d = length(w - sa - ab * u);
            float gapAt = px * 8.0 / len, shown = smoothstep(gapAt, gapAt * 1.5, u) * smoothstep(1.0 - gapAt, 1.0 - gapAt * 1.5, u);
            float nextDone = float(k) + 1.0 < B.y ? 1.0 : 0.0;
            if (nextDone > 0.5) c += lit * ink(d, px * 1.0) * 0.5 * shown;
            else if (isCur > 0.5) c += now * ink(d, px * 1.1) * shown * (0.35 + 0.9 * pow(0.5 + 0.5 * sin(u * 12.0 - t * 4.0), 4.0)) * (kind > 1.5 ? breathe : 1.0);
            else c += vec3(0.65, 0.72, 0.9) * ink(d, px * 0.7) * 0.28 * shown * step(0.5, fract(u * len / (px * 8.0)));
          }
          // the step's star
          float rs = length(w - sa);
          if (isCur > 0.5) c += now * (exp(-pow(rs / (px * 3.2), 2.0)) * 2.0 + exp(-rs / (px * 12.0)) * 0.6) * (kind > 1.5 ? breathe : 0.85 + 0.15 * sin(t * 3.0));
          else if (isDone > 0.5) c += lit * (exp(-pow(rs / (px * 2.2), 2.0)) * 1.5 + exp(-rs / (px * 7.0)) * 0.3);
          else c += vec3(0.7, 0.76, 0.95) * (exp(-pow(rs / (px * 1.5), 2.0)) * 0.6 + exp(-rs / (px * 5.0)) * 0.1);
        }
        if (kind > 1.5 && kind < 2.5) c += vec3(1.0, 0.7, 0.25) * glow * 0.15 * breathe;
      }
      col += c * (1.0 + 0.6 * hot);
    }
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i], M = uLinkB[i]; if (M.y < 0.5) continue;
      vec2 a = L.xy, b = L.zw, ab = b - a; float len2 = max(dot(ab, ab), 1e-9);
      float u = clamp(dot(w - a, ab) / len2, 0.0, 1.0), d = length(w - a - ab * u), h = fract((t - M.x) * 0.55);
      float tail = smoothstep(h - 0.32, h, u) * step(u, h);
      col += kindCol(M.z) * (exp(-pow(d / (px * 1.4), 2.0)) * tail * tail * 1.3 + exp(-length(w - a - ab * h) / (px * 4.0)) * 0.9);
    }
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i], X = uStarB[i]; vec2 d = w - S.xy; float r = length(d), big = X.x, age = t - S.z; vec3 c = kindCol(S.w);
      float k = 1.0 + (X.y > 0.5 ? 0.35 * sin(t * 2.4) : 0.0) + 0.6 * exp(-age * 2.5);
      float s = exp(-pow(r / (px * 2.6 * big), 2.0)) * 1.8 + exp(-r / (px * 16.0 * big)) * 0.55;
      s += (exp(-abs(d.x) / (px * 1.1)) * exp(-abs(d.y) / (px * 34.0 * big)) + exp(-abs(d.y) / (px * 1.1)) * exp(-abs(d.x) / (px * 34.0 * big))) * 0.4;
      col += c * s * k + vec3(1.0) * exp(-pow(r / (px * 1.3 * big), 2.0)) * 0.9;
      if (age < 1.4) col += c * exp(-pow((r - px * (10.0 + age * 42.0)) / (px * 1.6), 2.0)) * (1.0 - age / 1.4) * 0.9;
    }
    col *= 1.0 - 0.32 * dot(p * 0.85, p * 0.85);`,
}

export { ATLAS, SKY }
