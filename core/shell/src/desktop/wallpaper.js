// The wallpaper: each scene of desktop.js's WALLPAPERS is a small fragment shader on the GPU (SCENES, compiled the first
// time it is shown); plain is the appearance's own ground and needs no GPU. A scene draws at the screen's own pixels (a
// Retina or 4K screen's too: drawn at fewer and stretched, a scene looks soft), unless this GPU cannot keep up: then a
// little fewer, as measured when the scene is shown (SHARP). A live scene draws at most 30 frames a second, slower while a
// window covers most of it, not at all while the tab is hidden, the motion is off or the system asks for reduced motion.
// A scene may draw data too (`data: true`: the agents at work, their tasks — set({ data }) gives what to draw each frame).
// No WebGL (or a scene this GPU cannot compile): a gradient of the scene's colours.
import { WALLPAPERS } from '../../desktop.js'

// what every scene has: the size (uR), the time in seconds (uT), its four colours (uA–uD, desktop.js), how lively the
// agent is now (uK, 0–1: listening to the person, louder as they speak; working on what they said), how many of its pixels
// make one of the page's (uP: 2 on a Retina screen drawn sharp — a line one page pixel wide is uP of them), noise
const LIB = `precision highp float;
uniform vec2 uR; uniform float uT, uK, uP; uniform vec3 uA, uB, uC, uD;
vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(dot(h2(i), f), dot(h2(i + vec2(1, 0)), f - vec2(1, 0)), u.x), mix(dot(h2(i + vec2(0, 1)), f - vec2(0, 1)), dot(h2(i + vec2(1, 1)), f - vec2(1, 1)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 5; i++) { v += a * n2(p); p = m * p; a *= 0.5; } return v; }
float fbm3(vec2 p){ float v = 0.0, a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6); for (int i = 0; i < 3; i++) { v += a * n2(p); p = m * p; a *= 0.5; } return v; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }
vec2 hash22(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
`

// what the two composed landscapes (远山, 青绿) share: the paper, and mountain masses placed by hand (the picture is
// composed: the hills stay; the mist, the water and the living things move)
const HILLS = `
vec3 paper(vec2 p){ return uA * (0.97 + 0.05 * smoothstep(-0.6, 0.5, p.y)) * (0.985 + 0.03 * fbm3(p * vec2(2.0, 30.0))); }
// a mountain mass at m.x (half width m.y, height m.z, how steep m.w): one rounded crest with lesser peaks on it —
// (its crest, the same without the small peaks: what the colour below follows, so no streaks run down from each peak)
vec2 mass(float x, vec4 m, float seed){
  float u = (x - m.x) / m.y;
  float bell = exp(-pow(abs(u), m.w) * 1.5);
  float crest = m.z * bell * (0.78 + 0.32 * (1.0 - abs(n2(vec2(x * 3.4 / m.y + seed, seed)))));
  return vec2(crest + m.z * 0.04 * n2(vec2(x * 24.0 / m.y, seed * 2.0)) * bell, m.z * bell * 0.95);
}
// a clump of foliage in splashed ink (泼墨) at c (\`size\` its half extent): a wet wash spreading into the paper, its edge
// soft and uneven, a little ink pooled just inside it; then dabs of dark ink laid on it (点叶), more of them on its upper
// side. → how much ink (0–1)
float foliage(vec2 q, vec2 c, vec2 size, float seed){
  vec2 u = (q - c) / size;
  if (dot(u, u) > 2.8) return 0.0;
  float d = length(u) - 1.0 + 0.5 * fbm3(q * 60.0 + seed) + 0.1 * n2(q * 400.0 + seed) - 0.12 * u.y;
  // (the ink laid from the top: darker there, thinning downward)
  float body = smoothstep(0.14, -0.3, d) * (0.3 + 0.16 * fbm3(q * 190.0 + seed * 2.0)) * (0.75 + 0.45 * smoothstep(-1.0, 0.6, u.y));
  float rim = exp(-pow((d + 0.05) / 0.05, 2.0)) * 0.14;
  float cell = 0.0074, dabs = 0.0;
  vec2 gi = floor(q / cell);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 ci = gi + vec2(float(x), float(y)), h = hash22(ci + seed);
    vec2 cp = (ci + 0.2 + 0.6 * h) * cell, cu = (cp - c) / size;
    if (length(cu) > 0.8 + 0.2 * (h.x - 0.5) || hash(ci + seed + 7.0) > 0.3 + 0.35 * cu.y) continue;
    // a dab laid flat (横点): wider than tall, a little tilted, its edge broken
    float r = cell * (0.3 + 0.28 * hash(ci + 3.0)), ang = (h.x - 0.5) * 0.6;
    vec2 o = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * (q - cp);
    float k = length(o * vec2(1.0, 2.2)) + 0.4 * r * n2(q * 1300.0 + ci);
    dabs = max(dabs, smoothstep(r, r * 0.45, k) * (0.6 + 0.4 * h.y));
  }
  return clamp(max(body + rim, dabs * 0.92), 0.0, 1.0);
}
// ink laid over ink: a second wash darkens where it covers the first
float over(float a, float b){ return 1.0 - (1.0 - a) * (1.0 - b); }
`

const SCENES = {
  satin: { body: `// domain-warped folds, lit from above
    vec2 q = p * 1.15 + vec2(fbm(p + t * 0.02), fbm(p + vec2(3.1, 1.7) - t * 0.015)) * 0.9;
    float f = sin(q.x * 3.2 + sin(q.y * 2.3 + t * 0.05) * 1.7 + t * 0.04);
    float g = sin(q.x * 3.2 + 0.03 + sin(q.y * 2.3 + 0.03 + t * 0.05) * 1.7 + t * 0.04);
    float light = clamp((g - f) * 18.0 + 0.5, 0.0, 1.0), h = f * 0.5 + 0.5;
    col = mix(uA, uB, smoothstep(0.0, 1.0, h)); col = mix(col, uC, pow(light, 3.0) * 0.55); col += uD * pow(light, 14.0) * 0.18;
    col *= 0.85 + 0.25 * uv.y;` },
  drift: { body: `// slow colour fields
    float a = fbm(p * 0.9 + vec2(t * 0.015, -t * 0.01)), b = fbm(p * 1.3 - vec2(t * 0.01, t * 0.012) + 4.0);
    col = mix(uA, uB, smoothstep(-0.25, 0.45, a)); col = mix(col, uC, smoothstep(-0.1, 0.5, b) * 0.75); col = mix(col, uD, smoothstep(0.2, 0.6, a * b * 3.0) * 0.35);` },
  contour: { body: `// a landscape's height lines, drifting
    float f = fbm(p * 1.4 + vec2(t * 0.008, t * 0.005)) * 1.6 + uv.y * 0.15;
    float l = abs(fract(f * 9.0) - 0.5);
    col = mix(uA, uB, uv.y * 0.6 + f * 0.4);
    col = mix(uC, col, smoothstep(0.0, 0.035, l));
    col = mix(col, uD, 0.25 * (1.0 - uv.y));` },
  night: { body: `// a faint nebula and slow stars
    col = mix(uA, uB, uv.y * 0.9 + 0.1);
    col += uC * pow(max(fbm(p * 1.6 + vec2(t * 0.006, 0.0)) + 0.3, 0.0), 2.4) * 0.5;
    vec2 g = (p + vec2(t * 0.004, 0.0)) * 90.0, id = floor(g), f = fract(g) - 0.5; float r = hash(id);
    float s = step(0.985, r) * smoothstep(0.08, 0.0, length(f + (vec2(hash(id + 3.1), hash(id + 7.7)) - 0.5) * 0.6));
    col += uD * s * (0.5 + 0.5 * sin(t * (0.6 + r * 2.0) + r * 40.0));` },
  haze: { body: `// morning mist
    float a = fbm(p * 0.8 + vec2(t * 0.004, 0.0));
    col = mix(uA, uB, smoothstep(0.0, 1.0, uv.y)); col = mix(col, uC, smoothstep(-0.2, 0.5, a) * 0.6); col = mix(col, uD, (1.0 - uv.y) * 0.25);` },
  sandstone: { body: `// soft dunes
    float d = p.y * 2.2 + sin(p.x * 1.8 + 0.6) * 0.35 + fbm(p * 1.2) * 0.5;
    float band = sin(d * 4.0) * 0.5 + 0.5, shade = sin(d * 4.0 + 0.35) * 0.5 + 0.5;
    col = mix(uB, uA, band); col = mix(col, uC, pow(shade, 6.0) * 0.5); col = mix(col, uD, (1.0 - uv.y) * 0.2);` },

  // ── modern ──
  aurora: { fn: `
    float ridge2(float x, float seed){ float h = 0.0, a = 0.5, f = 1.0;
      for (int o = 0; o < 4; o++) { h += a * (1.0 - abs(n2(vec2(x * f, seed + float(o) * 1.7)))); a *= 0.5; f *= 2.03; }
      return h; }
    // the sky over the lake at p: stars, three curtains of light, the glow they cast, a dark range of hills
    vec3 sky(vec2 p, float t){
      vec3 c = mix(uB, uA, smoothstep(-0.2, 0.5, p.y));
      vec2 g = p * 170.0, id = floor(g), f = fract(g) - 0.5; float r = hash(id);
      c += vec3(0.85, 0.9, 1.0) * step(0.993, r) * smoothstep(0.14, 0.0, length(f - (hash22(id) - 0.5) * 0.6)) * (0.55 + 0.45 * sin(t * (0.8 + r * 3.0) + r * 60.0)) * smoothstep(-0.1, 0.2, p.y);
      vec3 au = vec3(0.0);
      for (int i = 0; i < 3; i++) {
        float fi = float(i);
        float x = p.x * (0.8 + 0.3 * fi) + fi * 2.3;
        float base = -0.05 + 0.1 * fi + 0.2 * fbm(vec2(x * 0.6 + t * 0.016, fi * 3.1 + t * 0.008)) + 0.045 * sin(x * 2.2 + t * 0.11 + fi);
        float d = p.y - base;
        float edge = smoothstep(-0.05, 0.015, d), fade = exp(-max(d, 0.0) * (4.0 - fi * 0.8));
        float rays = 0.35 + 0.65 * smoothstep(-0.35, 0.55, n2(vec2(x * 24.0 + t * 0.26, d * 1.4 - t * 0.07 + fi * 9.0)));
        float pulse = 0.7 + 0.3 * sin(t * 0.23 + fi * 2.0 + x * 1.4);
        au += mix(uC, uD, smoothstep(0.0, 0.3, d)) * edge * fade * rays * pulse * (1.0 - fi * 0.28);
      }
      c += au * 0.9 + uC * 0.05 * exp(-max(p.y + 0.16, 0.0) * 6.0);
      float hill = -0.16 + pow(max(ridge2(p.x * 1.2 + 2.0, 4.0) - 0.32, 0.0) * 1.5, 1.4) * 0.2;
      return mix(c, uA * 0.75 + uC * 0.03, smoothstep(0.002, -0.002, p.y - hill));
    }`,
  body: `// the northern lights over hills and a still lake that holds them; pines on the near shore
    float hz = -0.16;
    if (p.y > hz) col = sky(p, t);
    else {
      float dep = hz - p.y;
      float wob = (0.002 + dep * 0.012) * sin(p.y * 170.0 / (dep * 3.0 + 0.3) + t * 0.9) + 0.004 * n2(vec2(p.x * 3.0, p.y * 50.0 - t * 0.3));
      col = sky(vec2(p.x + wob, 2.0 * hz - p.y), t) * 0.6;
      col = mix(col, uA, smoothstep(0.05, 0.34, dep) * 0.45);
    }
    float tx = p.x * 34.0, tf = fract(tx) - 0.5, th = hash(vec2(floor(tx), 3.0));
    float shore = -0.43 + 0.04 * fbm3(vec2(p.x * 1.6, 7.0)) + 0.05 * smoothstep(0.2, 0.9, abs(p.x + 0.1));
    float trees = shore + (0.02 + 0.07 * th * smoothstep(0.1, 0.7, abs(p.x + 0.1))) * max(0.0, 1.0 - abs(tf) * 2.3) * (0.75 + 0.25 * sin(tf * 44.0));
    col = mix(col, uA * 0.4, smoothstep(0.002, -0.002, p.y - trees));` },
  ribbons: { body: `// a twisting band of glowing threads, a softer one behind it, both slowly turning
    col = mix(uA, uB, smoothstep(-0.6, 0.7, p.y + 0.25 * p.x));
    vec3 acc = vec3(0.0);
    for (int j = 0; j < 2; j++) {
      float back = float(j);
      float cx = 0.16 * sin(p.x * 1.0 + t * 0.08 + back * 2.0) + 0.07 * sin(p.x * 2.3 - t * 0.11) - back * 0.06;
      float w = (0.17 + 0.08 * sin(p.x * 0.7 + t * 0.06 + back * 1.7)) * (1.0 + back * 0.35);
      float ph = p.x * (1.7 - back * 0.5) + t * (0.2 - back * 0.07) + back * 1.3;
      vec3 hue = mix(uC, uD, smoothstep(-0.9, 0.9, p.x + 0.35 * sin(t * 0.05 + back * 3.0)));
      acc += hue * exp(-pow((p.y - cx) / (w * 1.2), 2.0)) * mix(0.11, 0.06, back);
      for (int i = 0; i < 24; i++) {
        float a = ph + float(i) / 23.0 * 3.14159;
        float lw = mix(0.0022, 0.0065, back), dy = abs(p.y - cx - w * sin(a));
        float lit = 0.2 + 0.8 * (0.5 + 0.5 * cos(a));
        acc += hue * (pow(lw / (dy + lw), 1.5) + 0.016 / (dy * 45.0 + 1.0)) * lit * mix(0.42, 0.13, back);
      }
    }
    col += acc;
    col = col / (1.0 + max(col - 0.85, 0.0));` },
  iris: { body: `// liquid chrome with a thin film of colour on it, slowly flowing under a soft light
    vec2 q = p * 1.1;
    vec2 w = vec2(fbm3(q * 0.8 + vec2(0.0, t * 0.035)), fbm3(q * 0.8 + vec2(5.2, 1.3) - t * 0.03));
    vec2 s = q + 1.6 * w;
    float e = 0.015, h = fbm3(s), hx = fbm3(s + vec2(e, 0.0)), hy = fbm3(s + vec2(0.0, e));
    vec3 n = normalize(vec3(-(hx - h) / e, -(hy - h) / e, 1.4));
    vec3 rf = reflect(vec3(0.0, 0.0, -1.0), n);
    float env = smoothstep(0.0, 0.65, rf.y) * 0.85 + smoothstep(0.5, 0.95, -rf.x) * 0.35 + smoothstep(0.6, 0.98, rf.x) * 0.15;
    float fres = pow(1.0 - n.z, 1.3);
    vec3 film = 0.5 + 0.5 * cos(6.2831 * (vec3(0.0, 0.33, 0.67) + h * 2.2 + rf.x * 0.4 + t * 0.012));
    col = uA + uB * (0.25 + 0.35 * h);
    col += mix(uD, film * uC * 1.4, 0.55) * env * 0.75;
    col += film * fres * 0.45;
    col *= 0.85 + 0.25 * uv.y;` },
  shallows: { fn: `
    // the light on the floor under a rippled surface: where the bent rays crowd together, 1 / the area a patch of light
    // spreads over (from the surface's curvature, waves in seven directions): the bright net of caustics
    float caustics(vec2 p, float t, float depth){
      mat2 H = mat2(0.0);
      for (int i = 0; i < 7; i++) {
        float fi = float(i), ang = fi * 2.39996 + 0.3;
        float kk = 20.0 + 16.0 * fract(fi * 0.618 + 0.2);
        vec2 k = vec2(cos(ang), sin(ang)) * kk;
        float s = sin(dot(k, p) - t * (0.7 + 0.25 * fi) + fi * 1.7) * 0.85 / (kk * kk);
        H -= s * mat2(k.x * k.x, k.x * k.y, k.x * k.y, k.y * k.y);
      }
      mat2 J = mat2(1.0) + depth * H;
      return 1.0 / max(abs(J[0][0] * J[1][1] - J[0][1] * J[1][0]), 0.05);
    }`,
  body: `// sunlight through moving water onto a sandy floor, the brightest lines split into colour
    col = mix(uA, uB, smoothstep(-0.7, 0.6, p.y + 0.15 * fbm3(p * 1.5 + t * 0.02)));
    col *= 0.85 + 0.3 * fbm3(p * 3.0 + vec2(9.0, 2.0));
    vec2 q = p + 0.08 * vec2(fbm3(p * 1.3 + vec2(0.0, t * 0.05)), fbm3(p * 1.3 + vec2(4.0, 1.0) - t * 0.04));
    vec3 c = vec3(caustics(q, t, 0.94), caustics(q, t, 1.0), caustics(q, t, 1.06));
    c = pow(c * 0.042, vec3(1.7));
    col += uC * c * (0.7 + 0.3 * smoothstep(-0.5, 0.5, p.y));
    float shafts = pow(max(0.5 + 0.5 * sin((p.x + p.y * 0.45) * 7.0 + fbm3(vec2(p.x * 2.0 + t * 0.03, t * 0.02)) * 5.0), 0.0), 6.0);
    col += uD * shafts * 0.08 * smoothstep(-0.4, 0.5, p.y);
    col *= 0.8 + 0.28 * uv.y;` },
  bokeh: { body: `// city lights far out of focus: soft discs with a brighter rim drifting up, near ones larger and softer, a warm glow low
    col = mix(uA, uB, smoothstep(-0.6, 0.6, p.y)) + uC * 0.14 * exp(-pow((p.y + 0.6) * 2.0, 2.0));
    float ax = uR.x / uR.y * 0.55;
    for (int i = 0; i < 64; i++) {
      float fi = float(i);
      vec2 h = hash22(vec2(fi, 7.3)), k = hash22(vec2(fi, 1.9));
      float r = mix(0.016, 0.115, k.x * k.x), soft = mix(0.003, 0.03, k.x);
      vec2 c = vec2((h.x * 2.0 - 1.0) * ax + 0.03 * sin(t * 0.17 + fi), mod(h.y * 1.3 + t * (0.003 + 0.009 * k.x), 1.3) - 0.65);
      float d = length(p - c), disk = smoothstep(r, r - soft, d), rim = disk * smoothstep(r - soft * 2.5, r - soft * 0.4, d);
      vec3 hue = k.y > 0.86 ? vec3(1.0, 0.95, 0.86) : mix(uC, uD, smoothstep(0.2, 0.8, k.y));
      col += hue * (disk * 0.6 + rim * 0.5) * mix(0.85, 0.3, k.x) * (0.7 + 0.3 * sin(t * 0.3 + fi * 2.1)) * smoothstep(0.55, -0.1, c.y * 0.6 + 0.1);
    }
    col = col / (1.0 + max(col - 0.9, 0.0));` },
  glass: { fps: 20, body: `// colour drifting behind reeded glass: each rib bends what is behind it and catches the light on one edge
    float cell = fract(p.x * 22.0) - 0.5;
    vec2 q = vec2(p.x - cell * 0.1, p.y);
    q += 0.1 * vec2(fbm3(q * 1.1 + t * 0.03), fbm3(q * 1.1 + vec2(3.0) - t * 0.025));
    float tt = t * 0.05;
    vec2 b1 = vec2(-0.45 + 0.25 * sin(tt * 1.3), 0.1 + 0.18 * cos(tt * 1.1));
    vec2 b2 = vec2(0.42 + 0.22 * cos(tt * 0.9 + 1.0), -0.14 + 0.2 * sin(tt * 1.2 + 2.0));
    vec2 b3 = vec2(0.05 + 0.3 * sin(tt * 0.7 + 4.0), 0.25 * cos(tt * 0.8 + 3.0));
    vec2 b4 = vec2(-0.1 + 0.35 * cos(tt * 0.6 + 2.0), -0.3 + 0.12 * sin(tt * 0.9));
    col = uA;
    col = mix(col, uB, exp(-dot(q - b1, q - b1) * 3.0));
    col = mix(col, uC, exp(-dot(q - b2, q - b2) * 2.6));
    col = mix(col, uD, exp(-dot(q - b3, q - b3) * 4.0) * 0.95);
    col = mix(col, vec3(1.0, 0.82, 0.5), exp(-dot(q - b4, q - b4) * 6.0) * 0.8);
    col += 0.16 * exp(-pow((cell + 0.38) * 14.0, 2.0)) - 0.09 * smoothstep(0.1, 0.5, cell);
    col *= 0.95 + 0.08 * uv.y;` },

  // ── intelligence (智能): the agent's own scenes; uK makes them livelier while it listens and works ──
  neural: { fn: `
    // a node of the net in cell c: it wanders inside its cell
    vec2 node(vec2 c, float t, float seed){ vec2 h = hash22(c + seed); return c + 0.5 + 0.36 * vec2(sin(t * (0.22 + 0.3 * h.x) + 6.2831 * h.y), cos(t * (0.2 + 0.3 * h.y) + 6.2831 * h.x)); }
    float seg(vec2 p, vec2 a, vec2 b, out float u){ vec2 pa = p - a, ba = b - a; u = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * u); }
    // the net at q (cells of 1): links between near nodes that fade as they part, signals running along some, nodes firing
    vec3 net(vec2 q, float t, float seed, float lw){
      vec2 c0 = floor(q); vec3 acc = vec3(0.0);
      for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
        vec2 ca = c0 + vec2(float(i), float(j)), a = node(ca, t, seed);
        float dn = length(q - a), fire = pow(max(0.5 + 0.5 * sin(t * (0.5 + hash(ca + seed) * 1.4) + hash(ca) * 40.0), 0.0), 14.0);
        acc += uD * (exp(-dn * dn / (lw * lw * 7.0)) * (0.7 + 2.0 * fire) + exp(-dn * 5.0) * 0.04 * (1.0 + 4.0 * fire));
        for (int k = 0; k < 4; k++) {
          vec2 o = k == 0 ? vec2(1.0, 0.0) : k == 1 ? vec2(0.0, 1.0) : k == 2 ? vec2(1.0, 1.0) : vec2(-1.0, 1.0);
          vec2 b = node(ca + o, t, seed);
          float len = length(b - a), on = smoothstep(1.4, 0.9, len);
          if (on <= 0.0) continue;
          float u, d = seg(q, a, b, u), h = hash(ca * 1.7 + o * 3.1 + seed);
          float line = exp(-pow(d / lw, 2.0)) + 0.1 * exp(-d / (lw * 5.0));
          float sig = step(0.6 - 0.35 * uK, h) * exp(-pow((u - fract(t * (0.2 + 0.3 * h) * (1.0 + uK) + h * 7.0)) * len / 0.04, 2.0));
          acc += mix(uC, uD, u) * on * line * (0.28 + sig * 3.0);
        }
      }
      return acc;
    }`,
  body: `// a living net: nodes drift, links form and part, signals run between them and nodes fire
    col = mix(uA, uB, smoothstep(-0.8, 0.9, p.y + 0.3 * p.x)) + uB * 0.4 * exp(-length(p - vec2(0.05, 0.0)) * 1.8);
    vec2 drift = vec2(t * 0.012, t * 0.005);
    col += net(p * 4.2 + drift + 11.0, t * 0.8, 3.0, 0.014) * 0.38;
    col += net(p * 2.4 + drift * 1.6, t, 0.0, 0.01) * (0.85 + 0.6 * uK);
    col = col / (1.0 + max(col - 0.9, 0.0));` },
  core: { body: `// the agent's core: plasma turning inside a glass sphere that breathes, three orbits round it with beads of light
    vec2 c = vec2(-0.1, 0.03);
    float R = 0.19 * (1.0 + 0.018 * sin(t * 0.9) + 0.07 * uK);
    vec2 q = p - c; float r = length(q);
    col = mix(uA, uB, smoothstep(1.0, 0.0, r) * 0.7);
    vec2 g = p * 140.0, id = floor(g); float st = step(0.994, hash(id));
    col += vec3(0.8, 0.9, 1.0) * st * smoothstep(0.3, 0.0, length(fract(g) - 0.5)) * 0.5 * smoothstep(0.25, 0.6, r);
    col += mix(uC, uD, 0.45) * (exp(-max(r - R, 0.0) * 8.0) * 0.3 + exp(-max(r - R, 0.0) * 28.0) * 0.4) * (1.0 + 1.2 * uK);
    vec3 back = vec3(0.0), front = vec3(0.0);
    for (int i = 0; i < 3; i++) {
      float fi = float(i), dir = i == 1 ? -1.0 : 1.0;
      float ang = 0.5 + fi * 1.05 + t * 0.025 * (fi + 1.0) * dir, squash = 0.24 + 0.1 * fi, rr = R * (1.5 + 0.3 * fi);
      vec2 e = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q; e.y /= squash;
      float d = abs(length(e) - rr) * squash, th = atan(e.y, e.x);
      float line = exp(-pow(d / 0.0022, 2.0)) * 0.75 + exp(-d * 110.0) * 0.1;
      // (max: rounding can take 0.5 + 0.5·cos a hair below 0, and pow of that is NaN — black dots in a line across the sky)
      float bead = pow(max(0.5 + 0.5 * cos(th * 2.0 - t * (0.45 + 0.2 * fi) * (1.0 + 1.5 * uK) * dir), 0.0), 60.0) * exp(-pow(d / 0.006, 2.0)) * 2.5;
      // near (e.y < 0) or far: a smooth share each, so the ring stays whole where its halves meet; the far side a
      // little dimmer, more so the further back
      float depth = clamp(e.y / rr, -1.0, 1.0), near = smoothstep(0.06, -0.06, depth);
      vec3 ring = mix(uC, uD, fi * 0.5) * (line + bead) * mix(0.62, 1.0, smoothstep(0.9, -0.9, depth));
      front += ring * near; back += ring * (1.0 - near) * (r < R ? 0.0 : 1.0);
    }
    col += back;
    if (r < R + 0.004) {
      float z = sqrt(max(1.0 - r * r / (R * R), 0.0));
      vec3 n = vec3(q / R, z);
      float a = t * 0.1 * (1.0 + 2.5 * uK);
      vec3 sp3 = vec3(n.x * cos(a) - n.z * sin(a), n.y, n.x * sin(a) + n.z * cos(a));
      vec2 sp = sp3.xy / (1.25 + sp3.z) * 2.4;
      vec2 w = vec2(fbm3(sp + t * 0.07), fbm3(sp + vec2(3.3, 1.1) - t * 0.06));
      float f = fbm(sp + 2.0 * w + t * 0.04 * (1.0 + 2.0 * uK));
      vec3 plasma = mix(uD, uC, smoothstep(-0.3, 0.35, f)) * (0.3 + 1.4 * smoothstep(-0.15, 0.45, f)) + vec3(1.0) * pow(smoothstep(0.15, 0.6, f), 3.0) * 0.7;
      vec3 orb = plasma * (0.3 + 0.7 * z) * (1.0 + 0.9 * uK) + mix(uC, vec3(1.0), 0.35) * pow(1.0 - z, 2.4) * 1.3;
      orb += vec3(1.0) * pow(max(dot(n, normalize(vec3(-0.45, 0.55, 0.75))), 0.0), 50.0) * 0.55;
      col = mix(col, orb, smoothstep(R, R - 0.004, r));
    }
    col += front;
    col = col / (1.0 + max(col - 0.9, 0.0));` },
  voice: { body: `// the agent's voice: bands of colour that swell slowly, and rise and fall with the person's voice as it listens
    col = mix(uA, uB, smoothstep(-0.7, 0.6, p.y));
    float yc = -0.02, amp = 0.09 + 0.22 * uK;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float fi = float(i);
      float env = exp(-pow(p.x * (1.05 + 0.15 * fi), 2.0) * 2.4);
      float swell = 0.5 + 0.5 * sin(t * (0.42 + 0.11 * fi) * (1.0 + 2.0 * uK) + fi * 1.7);
      float y = yc + amp * env * swell * sin(p.x * (7.0 + fi * 3.4) - t * (0.8 + 0.35 * fi) * (1.0 + 2.5 * uK) + fi * 2.1);
      float d = abs(p.y - y), w = 0.0022 + 0.0035 * env;
      vec3 hue = mix(uC, uD, fi / 4.0);
      if (i == 3) hue = mix(uD, vec3(1.0, 0.45, 0.7), 0.7);
      acc += hue * (exp(-pow(d / w, 2.0)) * 0.95 + 0.01 / (d * 28.0 + 0.35) * env);
      acc += hue * 0.07 * env * step(min(yc, y), p.y) * step(p.y, max(yc, y));
    }
    col += acc * 0.8 + mix(uC, uD, 0.5) * (0.08 + 0.12 * uK) * exp(-pow((p.y - yc) * 5.0, 2.0)) * exp(-p.x * p.x * 2.0);
    col = col / (1.0 + max(col - 0.85, 0.0));` },
  streams: { body: `// threads of data flowing in from everywhere to a hub and on out of it, packets of light running along them
    col = mix(uA, uB, smoothstep(-0.7, 0.7, p.y));
    vec2 hub = vec2(0.16, 0.02);
    float dx = p.x - hub.x;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 18; i++) {
      float fi = float(i), h = hash(vec2(fi, 3.7)), sl = (fi / 17.0 - 0.5) * 1.15;
      float y = hub.y + sl * dx * (1.0 + 0.2 * sin(t * 0.1 + fi)) + (h - 0.5) * 0.45 * dx * dx + 0.012 * sin(dx * 6.0 + t * 0.4 + fi);
      float d = abs(p.y - y) / sqrt(1.0 + sl * sl), w = 0.001 + 0.0028 * abs(dx);
      float line = exp(-pow(d / w, 2.0)) * 0.3 + 0.004 / (d * 50.0 + 0.5);
      float ph = fract(p.x * (5.0 + 4.0 * h) - t * (0.22 + 0.3 * h) * (1.0 + 2.0 * uK) + h * 9.0);
      float packet = exp(-pow((ph - 0.5) * 16.0, 2.0)) * exp(-pow(d / (w * 1.8), 2.0));
      acc += mix(uC, uD, smoothstep(-0.9, 0.9, p.x + (h - 0.5) * 0.7)) * (line * 0.5 + packet * 1.7) * smoothstep(0.0, 0.1, abs(dx) + 0.02);
    }
    float hr = length((p - hub) * vec2(1.0, 1.3));
    col += acc + mix(uC, vec3(1.0), 0.4) * (exp(-hr * 18.0) * 0.8 + exp(-hr * 5.0) * 0.18) * (0.85 + 0.15 * sin(t * 1.3) + 0.6 * uK);
    col = col / (1.0 + max(col - 0.9, 0.0));` },
  lattice: { fn: `
    // the field's height at world x, depth z (the eye is 1 above the flat ground): long slow swells and a rolling wave
    float swell(float x, float z, float t){ return min((0.5 * fbm3(vec2(x * 0.7, z * 0.55 - t * 0.12)) + 0.12 * sin(z * 1.3 + x * 0.4 - t * 0.8)) * (1.0 + 1.2 * uK), 0.55); }`,
  body: `// a field of points running to the horizon, rising in slow swells, a band of light sweeping toward you
    float hz = 0.08;
    col = mix(uB, uA, smoothstep(hz, 0.6, p.y)) + mix(uC, uD, 0.5) * 0.22 * exp(-abs(p.y - hz) * 10.0);
    if (p.y < hz) {
      float dy = hz - p.y, z = 0.3 / dy;
      float H = swell(p.x * z / 0.3, z, t);
      z = 0.3 * (1.0 - H) / dy; H = swell(p.x * z / 0.3, z, t);
      z = 0.3 * (1.0 - H) / dy;
      vec2 g = vec2(p.x * z / 0.3 * 6.0, z * 6.0 + t * (0.8 + 2.5 * uK));
      vec2 id = floor(g), cell = fract(g) - 0.5;
      float dotv = smoothstep(0.2, 0.08, length(cell)), vis = smoothstep(0.0012, 0.005, 0.3 / (z * z * 6.0));
      float twinkle = step(0.975, hash(id)) * (0.5 + 0.5 * sin(t * 2.0 + hash(id + 3.0) * 30.0));
      float scan = exp(-pow((fract(z * 0.16 - t * 0.09) - 0.5) * 9.0, 2.0));
      vec3 c = mix(uD, uC, smoothstep(-0.15, 0.3, H));
      col += c * dotv * vis * (0.1 + 2.2 * smoothstep(-0.15, 0.4, H) + 2.2 * twinkle + 1.2 * scan) * exp(-z * 0.03);
      col += mix(uC, uD, 0.5) * 0.14 * (1.0 - vis) * exp(-dy * 7.0);
    } else {
      vec2 g = p * 150.0, id = floor(g);
      col += vec3(0.75, 0.85, 1.0) * step(0.995, hash(id)) * smoothstep(0.3, 0.0, length(fract(g) - 0.5)) * 0.45 * smoothstep(hz, 0.3, p.y);
    }
    col = col / (1.0 + max(col - 0.9, 0.0));` },
  globe: { fn: `
    // the globe's dotted surface seen through n (a point of the unit sphere facing us, or the far side): land as dots,
    // a few bright places that pulse, the lines of latitude and longitude faint
    vec3 surface(vec3 n, float t){
      float a = t * 0.05, tl = 0.38;
      vec3 s = vec3(n.x, n.y * cos(tl) - n.z * sin(tl), n.y * sin(tl) + n.z * cos(tl));
      s = vec3(s.x * cos(a) + s.z * sin(a), s.y, -s.x * sin(a) + s.z * cos(a));
      float lat = asin(clamp(s.y, -1.0, 1.0)), lon = atan(s.z, s.x);
      float land = fbm3(s.xy * 1.7 + s.z * vec2(1.3, -0.9) + 4.0) + 0.5 * fbm3(s.yz * 3.1 - s.x * 1.7);
      vec2 g = vec2(lon / 6.2831 * 140.0, lat / 3.14159 * 70.0), id = floor(g), cell = fract(g) - 0.5;
      cell.x *= max(cos(lat), 0.2);
      float dotv = smoothstep(0.3, 0.12, length(cell)) * smoothstep(0.02, 0.1, land) * step(hash(id + 7.0), cos(lat) * 1.15);
      // each light twinkles at its own pace, and now and then one flashes white
      float h = hash(id + 3.0), tw = 0.6 + 0.4 * sin(t * (1.3 + 2.4 * h) + h * 50.0);
      float flash = pow(max(sin(t * (0.35 + 0.6 * h) + h * 80.0), 0.0), 40.0);
      // the cities: brighter, warmer, twinkling clearly (a sharp rise, a slower fall)
      float city = step(0.982, hash(id)) * step(0.06, land);
      float ph = fract(t * (0.25 + 0.35 * hash(id + 1.0)) + hash(id + 2.0)), pulse = exp(-ph * 5.0) * smoothstep(0.0, 0.04, ph);
      float grid = max(exp(-pow(fract(lat / 0.2618 + 0.5) - 0.5, 2.0) * 900.0), exp(-pow(fract(lon / 0.2618 + 0.5) - 0.5, 2.0) * 900.0));
      return uC * dotv * 0.75 * tw + vec3(0.85, 0.97, 1.0) * dotv * flash * 1.6
        + vec3(1.0, 0.92, 0.78) * city * (0.5 + 3.0 * pulse) * smoothstep(0.55, 0.0, length(cell)) + uD * grid * 0.12;
    }`,
  body: `// a holographic globe of dotted land turning slowly, the far side showing through, a glow round it
    vec2 c = vec2(-0.1, 0.0); float R = 0.31 * (1.0 + 0.03 * uK);
    vec2 q = (p - c) / R; float r = length(q);
    col = mix(uA, uB, smoothstep(1.6, 0.0, length(p - c)) * 0.75);
    vec2 g = p * 140.0, id = floor(g);
    col += vec3(0.8, 0.9, 1.0) * step(0.995, hash(id)) * smoothstep(0.3, 0.0, length(fract(g) - 0.5)) * 0.4 * smoothstep(1.1, 1.6, r);
    col += mix(uC, uD, 0.4) * (exp(-max(r - 1.0, 0.0) * 5.0) * 0.28 + exp(-max(r - 1.0, 0.0) * 22.0) * 0.3) * step(1.0, r) * (1.0 + uK);
    if (r < 1.0) {
      float z = sqrt(1.0 - r * r);
      col += surface(vec3(q, -z), t) * 0.22;
      col += surface(vec3(q, z), t) * (0.35 + 0.75 * z) * (1.0 + 0.6 * uK);
      col += mix(uC, uD, 0.5) * (pow(1.0 - z, 3.0) * 0.6 + 0.05);
    }
    col = col / (1.0 + max(col - 0.9, 0.0));` },

  // ── the agents' sky: the agents at work, drawn into the wallpaper (src/desktop/sky.jsx gives what to draw) ──
  sky: { data: true, fps: 24, fn: `
// what to draw (sky.jsx): each task a ring of its steps — uTask (centre, radius, kind: 1 at work, 2 waiting for the
// person, 3 scheduled, 4 just done, 5 failed), uTaskB (steps, steps done, the step at work, when it changed); each agent a
// star — uStar (where, when it last did something, its kind: 0 Claude, 1 Codex, 2 another, 3 a script, 4 the person),
// uStarB (size, waiting); each message a meteor — uLink (from, to), uLinkB (when it set off, colour); uN: the counts, the
// task the pointer is on
uniform vec4 uTask[8], uTaskB[8], uStar[16], uStarB[16], uLink[8], uLinkB[8]; uniform vec3 uN;
vec3 kindCol(float k){ return k < 0.5 ? vec3(1.0, 0.62, 0.42) : k < 1.5 ? vec3(0.42, 0.8, 1.0) : k < 2.5 ? vec3(0.7, 0.62, 1.0) : k < 3.5 ? vec3(0.66, 0.72, 0.8) : vec3(1.0, 0.72, 0.26); }
// gas lit from inside: deep blue to violet, dark red where it is thick, gold at its brightest — breathing slowly, each
// region in its own time, with dark dust in front
vec3 nebula(vec2 p, float t){
  vec2 q = p * 1.25 + vec2(t * 0.003, -t * 0.0015);
  vec2 w = vec2(fbm3(q + vec2(1.7, 9.2) + t * 0.008), fbm3(q + vec2(8.3, 2.8) - t * 0.006));
  float f = fbm(q + 1.7 * w), g = fbm3(q * 2.1 - 1.2 * w + vec2(0.0, t * 0.005));
  // each region breathes in its own time: brighter, then dimmer, over some ten seconds
  float breathe = 0.72 + 0.28 * sin(t * 0.32 + w.x * 7.0 + w.y * 4.0);
  float thick = smoothstep(-0.25, 0.45, f);
  vec3 col = mix(uA, uB * 1.9, smoothstep(-0.45, 0.35, f));
  // dark red gas where it is thick, in a pattern of its own: the blue gives way to it (red over blue, not a pink mix)
  float red = smoothstep(-0.05, 0.42, g + 0.35 * w.y - 0.1 * f) * thick;
  col = mix(col, uC * 2.3, red * 0.92);
  col += uC * 0.9 * red * red * (0.7 + 0.3 * breathe);
  // gold at its brightest, breathing
  col += uD * pow(max(f + 0.3 * g, 0.0), 2.4) * 1.1 * breathe;
  col *= (0.38 + 0.95 * thick) * (0.82 + 0.3 * breathe) * (1.0 + 0.35 * uK);
  // dark dust in front of it
  col *= 1.0 - 0.55 * smoothstep(0.1, 0.45, fbm3(q * 2.9 + w * 2.2 + 5.0)) * (1.0 - 0.5 * thick);
  return col;
}
// stars: one in some cells of a grid, sharp at the screen's own pixels, each twinkling in its own time
float starField(vec2 p, float t, float scale, float px, float keep, float big){
  vec2 g = p * scale, i = floor(g), f = fract(g);
  float h = hash(i);
  if (h < keep) return 0.0;
  float h2 = hash(i + 3.7);
  // (the star well inside its cell, its glow short: nothing of it is cut at the cell's edge)
  vec2 c = 0.3 + 0.4 * hash22(i + 1.3);
  vec2 d = (f - c) / scale;
  float r = length(d), size = px * (0.7 + 1.3 * h2) * big;
  float tw = 0.55 + 0.45 * sin(t * (0.4 + 2.6 * h2) + h2 * 60.0);
  float s = exp(-pow(r / size, 2.0)) + exp(-r / (px * 1.6 * big)) * 0.12;
  s += big > 1.5 ? (exp(-abs(d.x) / (px * 0.9)) * exp(-abs(d.y) / (px * 12.0)) + exp(-abs(d.y) / (px * 0.9)) * exp(-abs(d.x) / (px * 12.0))) * 0.35 : 0.0;
  float edge = max(abs(f.x - 0.5), abs(f.y - 0.5));
  return s * tw * (0.35 + 0.9 * h2) * smoothstep(0.5, 0.42, edge);
}`, body: `// the agents' sky
    float px = max(uP, 0.5) / uR.y;
    col = nebula(p, t);
    col += vec3(0.85, 0.9, 1.0) * starField(p, t, 70.0, px, 0.86, 1.0);
    col += vec3(1.0, 0.92, 0.85) * starField(p + 3.1, t, 22.0, px, 0.9, 1.4);
    col += vec3(0.8, 0.88, 1.0) * starField(p + 7.7, t * 0.7, 6.0, px, 0.82, 2.2);
    col += mix(vec3(1.0, 0.75, 0.6), vec3(0.75, 0.8, 1.0), hash(floor(p * 30.0))) * starField(p + 1.9, t * 2.2, 30.0, px, 0.9, 1.3) * 1.6 * smoothstep(0.15, 0.6, length(col));
    col *= 1.0 - 0.38 * dot(p * 0.85, p * 0.85);
    // the tasks: a ring of their steps each
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i];
      vec2 q = p - T.xy; float r = length(q), R = T.z, kind = T.w;
      float hot = abs(float(i) - uN.z) < 0.5 ? 1.0 : 0.0;
      float a = fract(0.25 - atan(q.y, q.x) / 6.2831853);
      float n = max(B.x, 1.0), seg = floor(a * n), within = fract(a * n), gw = min(0.3, 0.012 * n);
      float gap = smoothstep(0.0, gw, within) * smoothstep(1.0, 1.0 - gw, within);
      float line = exp(-pow((r - R) / (px * 1.2), 2.0)), glow = exp(-abs(r - R) / (px * 10.0));
      float breathe = 0.6 + 0.4 * sin(t * 2.2 + float(i));
      vec3 c = vec3(0.0);
      if (kind > 2.5 && kind < 3.5) {
        // scheduled, not running: a faint dotted ring
        c = mix(uB, vec3(0.8, 0.85, 1.0), 0.5) * line * step(0.55, fract(a * 72.0)) * (0.35 + 0.3 * hot);
      } else if (kind > 3.5 && kind < 4.5) {
        // just done: the ring flares green and widens as it fades
        float age = t - B.w, e = exp(-age * 1.5);
        float rr = R * (1.0 + age * 0.08);
        c = vec3(0.45, 1.0, 0.68) * (exp(-pow((r - rr) / (px * 1.6), 2.0)) * 1.4 + exp(-abs(r - rr) / (px * 14.0)) * 0.6) * e;
      } else {
        vec3 now = kind > 4.5 ? vec3(1.0, 0.36, 0.34) : kind > 1.5 ? vec3(1.0, 0.72, 0.28) : vec3(0.72, 0.9, 1.0);
        vec3 lit = mix(uD, vec3(1.0), 0.35);
        float flow = kind > 1.5 ? breathe : 0.55 + 0.45 * pow(max(0.5 + 0.5 * sin(within * 18.0 - t * 4.0), 0.0), 6.0);
        if (seg < B.y) c = lit * line * 0.9 * gap;
        else if (abs(seg - B.z) < 0.5) c = now * line * 1.5 * gap * flow;
        else c = vec3(0.7, 0.75, 0.9) * line * 0.22 * step(0.5, fract(a * n * 9.0)) * gap;
        float da = abs(fract(a - (B.z + 0.5) / n + 0.5) - 0.5) * n, near = B.z > -0.5 ? exp(-da * da * 1.2) : 0.0;
        float doneShare = clamp(B.y / n, 0.0, 1.0);
        c += mix(lit * (0.06 + 0.1 * doneShare), now * 0.5 * (kind > 1.5 ? breathe : 0.85), near) * glow;
        // waiting for the person: the whole ring warms and breathes
        if (kind > 1.5 && kind < 2.5) c += vec3(1.0, 0.7, 0.25) * glow * 0.22 * breathe;
        // the space it holds: a faint light inside
        c += now * exp(-r / max(R, px)) * 0.035 * (1.0 + hot);
      }
      col += c * (1.0 + 0.6 * hot);
    }
    // messages: meteors from one agent to another
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i], M = uLinkB[i];
      if (M.y < 0.5) continue;
      vec2 a = L.xy, b = L.zw, ab = b - a; float len2 = max(dot(ab, ab), 1e-6);
      float u = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
      float d = length(p - a - ab * u);
      float h = fract((t - M.x) * 0.55);
      float tail = smoothstep(h - 0.32, h, u) * step(u, h);
      col += kindCol(M.z) * (exp(-pow(d / (px * 1.4), 2.0)) * tail * tail * 1.3 + exp(-d / (px * 8.0)) * tail * 0.25 + exp(-length(p - a - ab * h) / (px * 4.0)) * 0.9);
      col += kindCol(M.z) * exp(-pow(d / (px * 0.8), 2.0)) * 0.08 * step(0.5, fract(u * sqrt(len2) * 160.0));
    }
    // the agents: stars, a ring going out of one each time it does something
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i], X = uStarB[i];
      vec2 d = p - S.xy; float r = length(d), big = X.x;
      vec3 c = kindCol(S.w);
      float waiting = X.y, age = t - S.z;
      float k = 1.0 + (waiting > 0.5 ? 0.35 * sin(t * 2.4) : 0.0) + 0.6 * exp(-age * 2.5);
      float s = exp(-pow(r / (px * 2.6 * big), 2.0)) * 1.8 + exp(-r / (px * 16.0 * big)) * 0.55;
      s += (exp(-abs(d.x) / (px * 1.1)) * exp(-abs(d.y) / (px * 34.0 * big)) + exp(-abs(d.y) / (px * 1.1)) * exp(-abs(d.x) / (px * 34.0 * big))) * 0.4;
      col += c * s * k + vec3(1.0) * exp(-pow(r / (px * 1.3 * big), 2.0)) * 0.9;
      if (age < 1.4) { float rr = px * (10.0 + age * 42.0); col += c * exp(-pow((r - rr) / (px * 1.6), 2.0)) * (1.0 - age / 1.4) * 0.9; }
    }` },
  // ── the agents' atlas: an old map — each task an island, its steps the stations of a road round it, its agents
  // banners on the road, messages couriers between them (the same data as the sky: sky.jsx) ──
  atlas: { data: true, fps: 20, fn: `
uniform vec4 uTask[8], uTaskB[8], uStar[16], uStarB[16], uLink[8], uLinkB[8]; uniform vec3 uN;
vec3 kindCol(float k){ return k < 0.5 ? vec3(0.78, 0.38, 0.16) : k < 1.5 ? vec3(0.16, 0.42, 0.62) : k < 2.5 ? vec3(0.42, 0.3, 0.62) : k < 3.5 ? vec3(0.4, 0.42, 0.44) : vec3(0.72, 0.2, 0.14); }
// a line of ink: dark where d is within w of 0, a little uneven like a brush
float ink(float d, float w){ return exp(-pow(d / w, 2.0)); }
float segD(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float u = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0); return length(p - a - ab * u); }
// old paper: its colour, stains, fibres, darker towards the burnt edges
vec3 paper(vec2 p, vec2 uv){
  vec3 c = uA * (0.94 + 0.08 * fbm(p * 1.1 + 3.0));
  c *= 1.0 - 0.1 * smoothstep(0.1, 0.6, fbm(p * 2.6 + 9.0));
  c *= 0.97 + 0.04 * n2(p * vec2(520.0, 34.0));
  float e = min(min(uv.x, 1.0 - uv.x) * uR.x / uR.y, min(uv.y, 1.0 - uv.y));
  c *= mix(0.55, 1.0, smoothstep(0.0, 0.12, e + 0.03 * fbm3(p * 9.0)));
  return c;
}
// the sea's waves: rows of small arcs, as old maps draw water
float waves(vec2 p, float px){
  vec2 g = p * vec2(26.0, 46.0); float row = floor(g.y);
  float x = fract(g.x + row * 0.5), y = fract(g.y);
  float arc = abs(y - 0.35 - 0.3 * sqrt(max(0.0, 1.0 - pow(2.0 * x - 1.0, 2.0))));
  return exp(-pow(arc / (px * 46.0 * 0.9), 2.0)) * step(0.35, hash(vec2(floor(g.x + row * 0.5), row)));
}
// a compass rose: eight points, a ring
float rose(vec2 q, float r, float px){
  float a = atan(q.y, q.x), d = length(q);
  float star = abs(cos(a * 4.0)), spike = mix(0.32, 1.0, pow(star, 6.0)) * r;
  float edge = ink(d - spike * (1.0 - 0.0), px * 1.2) * step(d, r * 1.02);
  float ring = ink(d - r * 0.62, px * 1.0) + ink(d - r * 0.68, px * 0.8) * 0.6;
  float fill = step(d, spike) * 0.12;
  return max(max(edge * 0.6, ring), fill);
}`, body: `// the agents' atlas
    float px = max(uP, 0.5) / uR.y;
    col = paper(p, uv);
    vec3 inkC = uC;
    // meridians and parallels, faint
    float grid = ink(abs(fract(p.x * 4.0 + 0.04 * sin(p.y * 3.0)) - 0.5) - 0.5, px * 4.0 * 0.7) + ink(abs(fract(p.y * 4.0) - 0.5) - 0.5, px * 4.0 * 0.7);
    col = mix(col, inkC, clamp(grid, 0.0, 1.0) * 0.1);
    float land = -1.0, landSeen = 0.0;
    // the islands: one a task
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i];
      vec2 q = (p - T.xy) / T.z; float R = T.z, kind = T.w, d = length(q);
      float hot = abs(float(i) - uN.z) < 0.5 ? 1.0 : 0.0;
      float seed = float(i) * 7.13 + 1.0;
      // capes and bays: bold at the island's own scale, finer along the shore — never so far in that the road is wet
      float lobes = 0.85 * fbm3(q * 0.75 + seed) + 0.2 * fbm3(q * 2.2 + seed * 1.7) + 0.03 * n2(q * 8.0 + seed);
      float coast = max(1.2 + lobes, 0.86);
      float f = (coast - d) * R; // > 0 on land, in the page's units
      bool fog = kind > 2.5 && kind < 3.5;
      // the shallows: a wash of sea green along the shore
      if (f < 0.0 && !fog) col = mix(col, vec3(0.6, 0.72, 0.64), 0.28 * exp(f / (px * 70.0)));
      if (f > 0.0) {
        // land: green and ochre washes, mottled; in fog: hatched and pale
        vec3 ground = mix(mix(uB, vec3(0.8, 0.72, 0.5), smoothstep(-0.2, 0.4, fbm3(q * 1.6 + seed * 3.0))), uA, 0.18 + 0.2 * fbm3(q * 3.0 + seed));
        col = mix(col, ground, fog ? 0.35 : 0.8);
        if (fog) col = mix(col, inkC, 0.08 * step(0.6, fract((p.x + p.y) * 160.0)));
        // mountains: small ink peaks, off the road
        vec2 g = q * 4.2 + seed, cell = floor(g), u = fract(g);
        float hm = hash(cell);
        if (!fog && hm > 0.7 && abs(d - 0.62) > 0.2 && f > R * 0.18) {
          float k = 0.55 + 0.45 * hash(cell + 2.3), w = px * 1.2 / (R / 4.2);
          vec2 top = vec2(0.5, 0.3 + 0.5 * k), l = vec2(0.5 - 0.32 * k, 0.3), r = vec2(0.5 + 0.32 * k, 0.3);
          float m = min(segD(u, l, top), segD(u, top, r));
          col = mix(col, inkC, ink(m, w) * 0.6);
          // the shaded side: a few hatches
          float side = step(l.x + (u.y - 0.3) / max(top.y - 0.3, 1e-3) * (top.x - l.x), u.x) * step(u.x, 0.5) * step(0.3, u.y) * step(u.y, top.y);
          col = mix(col, inkC, side * step(0.55, fract((u.x - u.y) * 14.0)) * 0.22);
        } else if (!fog && hm > 0.42 && hm < 0.62 && abs(d - 0.62) > 0.18 && f > R * 0.14) {
          // a wood: a few round trees, green with an ink edge
          for (int k = 0; k < 3; k++) {
            vec2 tc = vec2(0.28 + 0.22 * float(k), 0.4 + 0.18 * hash(cell + float(k)));
            float tr = length(u - tc) * (R / 4.2), rr = px * (3.2 + 1.2 * hash(cell + float(k) + 5.0));
            col = mix(col, vec3(0.42, 0.52, 0.3), smoothstep(rr, rr - px, tr) * 0.75);
            col = mix(col, inkC, ink(tr - rr, px * 0.8) * 0.7);
          }
        }
      }
      // the coast: an ink line; the water's lines round it
      float coastInk = ink(f, px * (fog ? 0.9 : 1.4)) * (fog ? step(0.5, fract(atan(q.y, q.x) * 18.0)) * 0.6 : 1.0);
      float ripple = f < 0.0 ? ink(abs(fract(-f / (px * 7.0)) - 0.5) - 0.5, 0.18) * exp(f / (px * 24.0)) : 0.0;
      col = mix(col, inkC, clamp(coastInk * 0.85 + ripple * 0.25 * (fog ? 0.4 : 1.0), 0.0, 1.0));
      landSeen = max(landSeen, smoothstep(-px * 30.0, 0.0, f));
      if (fog) continue;
      // the road round it: done stretches drawn in full, the rest dashed; its stations one a step
      float n = max(B.x, 1.0), a = fract(0.25 - atan(q.y, q.x) / 6.2831853);
      float roadD = abs(d - 0.62) * R;
      float done = a < B.y / n ? 1.0 : 0.0;
      float road = ink(roadD, px * 1.1) * (done > 0.5 ? 1.0 : step(0.45, fract(a * n * 7.0)) * 0.7);
      col = mix(col, inkC, road * 0.75);
      for (int k = 0; k < 12; k++) {
        if (float(k) >= n) break;
        float th = (0.25 - (float(k) + 0.5) / n) * 6.2831853;
        vec2 c = T.xy + vec2(cos(th), sin(th)) * 0.62 * R;
        float r = length(p - c);
        float isCur = abs(float(k) - B.z) < 0.5 ? 1.0 : 0.0, isDone = float(k) < B.y ? 1.0 : 0.0;
        if (isCur > 0.5 && kind > 1.5 && kind < 2.5) {
          // waiting for the person: a vermilion seal, breathing
          vec2 e = abs(p - c) - vec2(px * 8.0);
          float box = max(e.x, e.y), pulse = 0.75 + 0.25 * sin(t * 2.4);
          col = mix(col, uD, smoothstep(px, -px, box) * 0.85 * pulse);
          col = mix(col, uA, ink(box + px * 2.5, px * 0.8) * 0.8 * pulse);
        } else if (isCur > 0.5) {
          col = mix(col, uD, smoothstep(px * 5.0, px * 3.5, r));
          float rr = px * (6.0 + 9.0 * fract(t * 0.6));
          col = mix(col, uD, ink(r - rr, px * 1.0) * (1.0 - fract(t * 0.6)) * 0.7);
        } else {
          float town = smoothstep(px * 3.8, px * 2.6, r);
          col = mix(col, isDone > 0.5 ? inkC : uA, town);
          col = mix(col, inkC, ink(r - px * 3.4, px * 0.9) * 0.9);
        }
      }
      // just done: a round vermilion seal over the island, fading
      if (kind > 3.5 && kind < 4.5) {
        float age = t - B.w, e = exp(-age * 0.5);
        float sd = length(p - T.xy);
        col = mix(col, uD, (ink(sd - R * 0.34, px * 2.2) + ink(sd - R * 0.27, px * 1.2) + smoothstep(R * 0.1, R * 0.08, sd) * 0.8) * e * 0.9);
      }
      if (hot > 0.5) col = mix(col, inkC, ink(f - px * 6.0, px * 1.2) * 0.35);
    }
    // the sea: waves where there is no land near
    col = mix(col, inkC, waves(p, px) * 0.13 * (1.0 - landSeen));
    // the compass rose, low on the left
    vec2 rq = p - vec2(0.5 * uR.x / uR.y - 0.14, -0.33);
    float ra = atan(rq.y, rq.x), rl = length(rq);
    float rhumb = abs(fract(ra * 16.0 / 6.2831853 + 0.5) - 0.5) * 6.2831853 / 16.0 * rl;
    col = mix(col, inkC, ink(rhumb, px * 0.7) * 0.07 * smoothstep(0.06, 0.12, rl));
    col = mix(col, inkC, rose(rq, 0.06, px) * 0.65);
    // couriers: a dotted way between two banners, a red dot running along it
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i], M = uLinkB[i];
      if (M.y < 0.5) continue;
      vec2 a = L.xy, b = L.zw, ab = b - a; float len2 = max(dot(ab, ab), 1e-6);
      float u = clamp(dot(p - a, ab) / len2, 0.0, 1.0), d = length(p - a - ab * u);
      col = mix(col, inkC, ink(d, px * 0.9) * step(0.5, fract(u * sqrt(len2) / (px * 9.0))) * 0.6);
      float h = fract((t - M.x) * 0.35);
      col = mix(col, uD, smoothstep(px * 4.5, px * 3.0, length(p - a - ab * h)));
    }
    // the agents: a banner each on its station — a coloured disc with an ink ring, a pennant on a mast
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i], X = uStarB[i];
      vec2 d = p - S.xy; float r = length(d);
      vec3 c = kindCol(S.w);
      float age = t - S.z;
      if (age < 1.6) col = mix(col, inkC, ink(r - px * (8.0 + age * 28.0), px * 1.2) * (1.0 - age / 1.6) * 0.5);
      vec2 m = d - vec2(0.0, px * 8.0);
      float mast = ink(m.x, px * 0.8) * step(0.0, m.y) * step(m.y, px * 14.0);
      vec2 fl = d - vec2(0.0, px * 15.0);
      float wave = sin(t * 3.0 + S.x * 40.0) * px * 1.2;
      float flag = step(0.0, fl.x) * step(fl.x, px * 11.0) * step(abs(fl.y - wave * fl.x / (px * 11.0)), px * 4.0 * (1.0 - fl.x / (px * 12.0)));
      col = mix(col, inkC, mast * 0.9);
      col = mix(col, c, flag * 0.95);
      col = mix(col, c, smoothstep(px * 6.0, px * 4.6, r));
      col = mix(col, inkC, ink(r - px * 5.6, px * 1.0));
      col = mix(col, vec3(1.0), smoothstep(px * 2.2, px * 1.2, length(d + vec2(px * 1.5, -px * 1.5))) * 0.5);
    }` },

  // ── classical (古风) ──
  ink: { fps: 15, fn: `${HILLS}
    // xuan paper: warm, a little mottled, its fibres showing — fine strands lying every way, a few lighter, a few darker
    vec3 xuan(vec2 p){
      vec3 c = paper(p) * (0.992 + 0.02 * fbm3(p * 9.0 + 4.0));
      float f = 0.0;
      for (int i = 0; i < 3; i++) {
        float a = float(i) * 2.09 + 0.4; vec2 dir = vec2(cos(a), sin(a));
        vec2 q = vec2(dot(p, dir), dot(p, vec2(-dir.y, dir.x))) * vec2(70.0, 1300.0);
        f += pow(1.0 - abs(n2(q + float(i) * 17.0)), 14.0) * smoothstep(0.15, 0.55, n2(p * 45.0 + float(i) * 5.0));
      }
      return c * (1.0 + 0.03 * f);
    }
    vec3 PAPER; // the paper here (body sets it): what a nearer hill hides the ones behind it with
    // how much ink the paper takes up here (it soaks unevenly)
    float absorb(vec2 p){ return 0.86 + 0.16 * fbm3(p * 48.0) + 0.06 * n2(p * 260.0); }
    float bell(float x, vec4 m){ return m.z * exp(-pow(abs((x - m.x) / m.y), m.w) * 1.5) * 0.95; }
    // a range of ink (masses a, b, c over \`base\`), painted as a hill is: a wet wash darkest under the ridge, fading down
    // into the mist (gone \`foot\` below it), uneven where the paper drank more; hemp-fibre strokes (披麻皴) running down
    // its flanks and leaning out as they do, each its own length, broken where the brush ran dry; the ridge one line of
    // changing weight; a little ink bled past it into the paper; \`moss\`: dabs along the ridge (苔点)
    vec3 range(vec3 col, vec2 p, float base, vec4 a, vec4 b, vec4 c, float dark, float foot, float seed, float moss){
      if (p.y > base + (a.z + b.z + c.z) * 1.15 + 0.01) return col; // (above anything it could reach: the sky)
      if (bell(p.x, a) + bell(p.x, b) + bell(p.x, c) < 0.002) return col;
      vec2 h = mass(p.x, a, seed) + mass(p.x, b, seed + 1.0) + mass(p.x, c, seed + 2.0);
      if (h.y < 0.003) return col;
      float px = 1.0 / uR.y;
      float top = base + h.x + 0.0012 * n2(p * 80.0 + seed);
      float d = top - p.y;
      if (d < -0.008) return col;
      float ds = max(base + h.y - p.y, 0.0), rise = smoothstep(0.0, 0.07, h.y);
      float inside = smoothstep(-px * 0.7, px * 0.7, d);
      float bleed = step(d, 0.0) * exp(d / (px * 2.4)) * (0.45 + 0.55 * n2(p * 1100.0 + seed)) * 0.22;
      // the wash
      float body = pow(clamp(1.0 - ds / foot, 0.0, 1.0), 1.6);
      vec2 r = vec2(p.x * 11.0 + p.y * 6.0, p.y * 13.0 - p.x * 5.0);
      float wash = body * (0.8 + 0.26 * fbm3(r + seed)) * absorb(p + seed);
      wash *= 0.78 + 0.3 * smoothstep(-0.3, 0.4, fbm3(vec2(p.x * 9.0, ds * 14.0) + seed * 1.7)); // lighter faces, darker folds
      // the strokes: two sets, leaning out with the flank (the slope taken broadly, and only so far down, so that
      // neighbouring strokes spread apart and never cross)
      float e = 0.03;
      float sl = (bell(p.x + e, a) + bell(p.x + e, b) + bell(p.x + e, c) - bell(p.x - e, a) - bell(p.x - e, b) - bell(p.x - e, c)) / (2.0 * e);
      float s = p.x + clamp(sl, -2.0, 2.0) * 0.22 * min(ds, 0.12) + 0.004 * n2(vec2(p.x * 18.0, ds * 22.0) + seed), cun = 0.0;
      for (int j = 0; j < 2; j++) {
        float fj = float(j), sp = mix(0.0042, 0.0069, fj), k = s / sp + seed * 7.0 + fj * 3.3;
        float id = floor(k), fr = fract(k) - 0.5 - (hash(vec2(id, seed + fj)) - 0.5) * 0.5;
        float w = 0.08 + 0.15 * hash(vec2(id, 3.0 + fj));
        float st = 0.001 + 0.03 * hash(vec2(id, 5.0 + fj)) * hash(vec2(id, 6.0)), len = 0.025 + 0.12 * hash(vec2(id, 7.0 + fj));
        float along = smoothstep(st, st + 0.006, ds) * smoothstep(st + len, st + len * 0.5, ds);
        float dry = smoothstep(-0.3, 0.35, n2(vec2(id * 3.7, ds * 160.0 + fj * 9.0)));
        cun = max(cun, smoothstep(w, w * 0.3, abs(fr)) * along * dry * step(0.3, hash(vec2(id, 9.0 + fj))) * (0.45 + 0.55 * hash(vec2(id, 11.0))));
      }
      cun *= clamp(1.0 - ds / (foot * 1.2), 0.0, 1.0) * smoothstep(0.4, 0.8, dark); // (none on the far, pale ranges)
      // the ridge line
      float lw = px * (0.9 + 1.7 * smoothstep(-0.4, 0.6, n2(vec2(p.x * 22.0, seed))));
      float ridge = smoothstep(lw, lw * 0.35, abs(d - lw * 0.7)) * smoothstep(-0.55, 0.15, n2(vec2(p.x * 150.0, seed * 3.0)));
      // moss dabs along the ridge: short flat strokes in the darkest ink, in twos and threes
      float dabs = 0.0;
      if (moss > 0.5 && d < 0.03) {
        float cw = 0.016, cell = floor(p.x / cw);
        for (int k = -1; k <= 1; k++) {
          float ci = cell + float(k);
          if (hash(vec2(ci, seed)) < 0.62) continue;
          float cx = (ci + 0.5) * cw;
          vec2 hh = mass(cx, a, seed) + mass(cx, b, seed + 1.0) + mass(cx, c, seed + 2.0);
          if (hh.x < hh.y * 1.0 || hh.y < 0.6 * max(max(a.z, b.z), c.z)) continue; // (on the high small peaks only)
          for (int m = 0; m < 3; m++) {
            vec2 o = (hash22(vec2(ci, float(m) + seed)) - 0.5) * vec2(0.012, 0.004);
            vec2 q = p - vec2(cx + o.x, base + hh.x - 0.003 + o.y);
            float ang = (hash(vec2(ci, float(m) * 3.0)) - 0.5) * 0.8;
            q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
            dabs = max(dabs, smoothstep(1.0, 0.6, length(q / vec2(0.0042, 0.0016)) + 0.25 * n2(q * 2400.0)) * step(float(m), 2.0 * hash(vec2(ci, 2.0)) + 0.5));
          }
        }
      }
      float amt = clamp(dark * rise * (inside * (wash + cun * 0.6) + ridge * 0.92) + dabs * 0.95, 0.0, 1.0);
      col = mix(col, PAPER, inside * rise * smoothstep(0.3, 0.8, dark) * 0.85); // (a near hill hides what is behind it)
      return mix(col, uB, max(amt, bleed * dark * rise));
    }
    // a line of ink from a to b, \`w0\` wide at a and \`w1\` at b, dry at its end — and how far along it q is (0 at a)
    float stroke(vec2 q, vec2 a, vec2 b, float w0, float w1){
      vec2 ab = b - a; float u = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
      float w = mix(w0, w1, u);
      return smoothstep(w, w * 0.4, length(q - a - ab * u)) * (1.0 - 0.6 * smoothstep(0.75, 1.0, u) * step(0.0, n2(q * 900.0)));
    }
    // the pine on its rock, at q = 0 the foot of its trunk: a rock in contour strokes; a trunk that leans and thins as it
    // rises, drawn by its two edges with its scaled bark between; branches reaching out and up, tapering; its foliage in
    // flat pads of splashed ink with dark dabs on them
    float pine(vec2 q){
      if (q.x < -0.16 || q.x > 0.2 || q.y > 0.33) return 0.0; // (nowhere near it)
      float px = 1.0 / uR.y, ink = 0.0;
      // the rock
      float rx = q.x - 0.01;
      float rockTop = -0.012 + 0.034 * exp(-pow(rx / 0.08, 2.0)) + 0.007 * n2(vec2(q.x * 34.0, 1.0)) + 0.004 * n2(vec2(q.x * 90.0, 2.0)) - 0.3 * smoothstep(0.07, 0.3, abs(rx));
      float rd = rockTop - q.y;
      if (rd > -0.004) {
        float edge = smoothstep(px * 2.2, px * 0.5, abs(rd - px * 1.2)) * smoothstep(-0.4, 0.2, n2(vec2(q.x * 120.0, 3.0)));
        float wash = smoothstep(-px, px, rd) * exp(-rd * 22.0) * (0.55 + 0.25 * fbm3(q * 60.0)) * absorb(q);
        // strokes following its contour inside it, broken, fewer further down
        float k = rd / 0.0085 + 0.7 * n2(q * 28.0), kf = abs(fract(k) - 0.5);
        float line = smoothstep(0.16, 0.04, kf) * smoothstep(0.0, 0.5, n2(vec2(q.x * 70.0, floor(k) * 3.1))) * smoothstep(0.0, 0.003, rd) * exp(-rd * 26.0);
        ink = max(ink, max(edge, wash + line * 0.55));
      }
      // the trunk: its middle, its width
      float tc = 0.11 * pow(max(q.y, 0.0), 1.35) - 0.025 * sin(q.y * 13.0);
      float tw = mix(0.0095, 0.0024, pow(clamp(q.y / 0.27, 0.0, 1.0), 0.8)) * (1.0 + 0.12 * n2(vec2(q.y * 40.0, 7.0)));
      float tu = (q.x - tc) / tw; // -1 … 1 across it
      if (abs(tu) < 1.3 && q.y > -0.02 && q.y < 0.275) {
        float edges = smoothstep(0.62, 0.95, abs(tu)) * smoothstep(1.15, 0.95, abs(tu)) * (0.75 + 0.25 * step(-0.2, n2(vec2(q.y * 240.0, tu))));
        // its bark: irregular scales, short curved marks, darker towards its shaded (right) side
        float bark = smoothstep(0.22, 0.5, n2(vec2(tu * 2.2 + n2(q * 300.0) * 0.4, q.y * 150.0))) * step(abs(tu), 0.85);
        ink = max(ink, max(edges * 0.95, smoothstep(1.0, 0.8, abs(tu)) * (0.26 + 0.14 * smoothstep(-0.6, 0.9, tu)) + bark * 0.5));
      }
      // the branches and their needles
      for (int i = 0; i < 5; i++) {
        float fi = float(i), y = 0.09 + 0.042 * fi, side = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
        vec2 a = vec2(0.11 * pow(y, 1.35) - 0.025 * sin(y * 13.0), y - 0.01);
        vec2 e = a + vec2(side * (0.065 - 0.008 * fi), 0.022);
        vec2 m = mix(a, e, 0.5) + vec2(0.0, 0.008);
        float wb = mix(0.0026, 0.0016, fi / 4.0);
        ink = max(ink, max(stroke(q, a, m, wb, wb * 0.75), stroke(q, m, e, wb * 0.75, wb * 0.35)) * 0.95);
        // its foliage: a flat pad of splashed ink along it, a smaller one over it (pines in ink are drawn in such layers)
        vec2 fc = mix(a, e, 0.68) + vec2(0.0, 0.01);
        ink = over(ink, foliage(q, fc, vec2(0.058 - 0.006 * fi, 0.021), fi * 3.1));
        ink = over(ink, foliage(q, fc + vec2(side * 0.012, 0.016), vec2(0.036 - 0.003 * fi, 0.014), fi * 3.1 + 1.7) * 0.85);
      }
      // the crown
      vec2 crown = vec2(0.11 * pow(0.27, 1.35) - 0.025 * sin(0.27 * 13.0), 0.27);
      ink = over(ink, foliage(q, crown + vec2(-0.002, 0.008), vec2(0.046, 0.02), 31.0));
      ink = over(ink, foliage(q, crown + vec2(0.006, 0.024), vec2(0.026, 0.013), 37.0) * 0.85);
      return ink;
    }
    // a bird: two strokes from its body out, thinning to the tips, flapping
    float bird(vec2 q, float t){
      float px = 1.0 / uR.y, flap = 0.35 * sin(t * 5.0), w = abs(q.x);
      float y = w * (0.55 + flap) - w * w * 9.0;
      float th = mix(px * 1.7, px * 0.4, clamp(w / 0.012, 0.0, 1.0));
      return smoothstep(th, th * 0.3, abs(q.y - y)) * step(w, 0.012) + smoothstep(px * 2.2, px * 0.8, length(q * vec2(1.0, 1.6)));
    }`,
  // drawn once: the paper, the sun, the hills in their strokes
  still: `PAPER = xuan(p);
    col = PAPER;
    // a pale red sun, low, behind the right-hand range: its pigment a little uneven, its edge soft
    float sd = length(p - vec2(0.43, 0.15));
    col = mix(col, mix(uA, uD, 0.6 + 0.08 * fbm3(p * 40.0)), smoothstep(0.042, 0.0395 + 0.0012 * n2(p * 120.0), sd) * 0.82);
    // the farthest range: faint, low, almost mist
    col = range(col, p, -0.12, vec4(0.66, 0.42, 0.24, 1.6), vec4(0.05, 0.45, 0.18, 1.4), vec4(0.0, 1.0, 0.0, 2.0), 0.14, 0.2, 1.0, 0.0);
    // the right-hand range, lighter, its feet lost in mist
    col = range(col, p, -0.24, vec4(0.5, 0.26, 0.33, 1.9), vec4(0.88, 0.2, 0.22, 1.7), vec4(0.0, 1.0, 0.0, 2.0), 0.34, 0.2, 4.0, 0.0);
    col = mix(col, PAPER, smoothstep(0.0, -0.16, p.y) * 0.55);
    // the main peak (left of centre): tall, its ridge darkest, its flanks in strokes, moss on its ridge
    col = range(col, p, -0.36, vec4(-0.35, 0.25, 0.66, 2.2), vec4(-0.06, 0.15, 0.36, 1.9), vec4(-0.72, 0.2, 0.34, 1.7), 0.8, 0.42, 7.0, 1.0);
    col = mix(col, PAPER, smoothstep(-0.14, -0.32, p.y) * 0.85);
    // low near hills on the right, the darkest ink, soon gone into the mist
    col = range(col, p, -0.5, vec4(0.6, 0.28, 0.2, 1.5), vec4(0.22, 0.16, 0.12, 1.5), vec4(0.0, 1.0, 0.0, 2.0), 0.85, 0.16, 11.0, 1.0);
    col = mix(col, PAPER, smoothstep(-0.36, -0.5, p.y) * 0.7);`,
  body: `// far hills in ink and mist: a main peak on the left, ranges falling away to the right, a pine on a rock, birds
    col = texture2D(uS, uv).rgb;
    // a broad band of mist drifting across the main peak's foot, the paper's white, with finer wisps in it
    float mist = smoothstep(-0.26, -0.08, p.y) * smoothstep(0.08, -0.1, p.y);
    if (mist > 0.0) {
      mist *= smoothstep(0.2, 0.65, fbm(vec2(p.x * 1.3 - t * 0.01, p.y * 6.0 + 2.0)) + 0.4) * (0.85 + 0.15 * fbm3(vec2(p.x * 4.0 - t * 0.02, p.y * 40.0)));
      col = mix(col, paper(p) * 1.01, mist * 0.8);
    }
    // the pine on its rock, lower left, swaying a little
    float pr = uR.x / uR.y;
    vec2 pq = p - vec2(-0.5 * pr + 0.17, -0.42);
    pq.x -= 0.03 * pow(max(pq.y, 0.0), 1.5) * sin(t * 0.45);
    col = mix(col, uB * 0.92, pine(pq) * 0.92);
    // three birds crossing slowly
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      vec2 bp = vec2(mod(t * 0.012 + fi * 0.05, 2.4) - 1.2 + 0.18, 0.27 + 0.022 * fi + 0.004 * sin(t * 0.3 + fi));
      col = mix(col, uB, bird(p - bp, t + fi) * 0.7);
    }` },
  azure: { fps: 15, fn: `${HILLS}
    float bell(float x, vec4 m){ return m.z * exp(-pow(abs((x - m.x) / m.y), m.w) * 1.5) * 0.95; }
    // three masses' crests (and soft crests) at x: a range
    vec2 peaks(float x, vec4 a, vec4 b, vec4 c, float seed){ return mass(x, a, seed) + mass(x, b, seed + 1.0) + mass(x, c, seed + 2.0); }
    float jag(float x, float hy, float seed){ return hy * 0.05 * (1.0 - abs(n2(vec2(x * 38.0, seed)))); }
    float COVER; // how much of this pixel the land drawn so far covers (the still part: the water shows where it does not)
    // old silk: its warp and weft (threads a little uneven), aged at its edges, a few faint stains
    vec3 silk(vec2 p, vec2 uv){
      vec2 f = gl_FragCoord.xy / max(uP, 1.0);
      float warp = 0.5 + 0.5 * sin(f.x * 2.1 + 2.5 * n2(vec2(f.x * 0.03, 1.0)));
      float weft = 0.5 + 0.5 * sin(f.y * 2.3 + 2.5 * n2(vec2(2.0, f.y * 0.03)));
      vec3 c = paper(p) * (0.978 + 0.03 * warp * weft + 0.012 * n2(vec2(f.x * 0.5, f.y * 0.012)));
      c = mix(c, c * mix(vec3(1.0), uD / max(max(uD.r, uD.g), uD.b), 0.35), smoothstep(0.5, 0.75, fbm3(p * 3.2 + 7.0)) * 0.18);
      return c * (1.0 - 0.12 * pow(length(uv - 0.5) * 1.25, 2.4));
    }
    // one range in mineral colours (青绿): ochre at its feet, malachite green above, azurite blue on its peaks, laid in
    // layers whose edges are the brush's (dry, uneven), the pigment coarse — its grains catching the light on the blue —
    // the light from the upper left; hemp-fibre strokes (披麻皴) in deep green running down the flanks; an outline of
    // changing weight; moss dots (苔点) in clusters on the high places; on the water below it, its reflection
    // (\`far\`: how much of the silk shows through; < 0: no water below it)
    vec3 range(vec3 col, vec2 p, float base, vec4 a, vec4 b, vec4 c, float seed, float far, float blueAt){
      if (p.y > base + (a.z + b.z + c.z) * 1.2 + 0.01) return col;
      vec2 h = peaks(p.x, a, b, c, seed);
      float clear = max(far, 0.0), px = 1.0 / uR.y;
      if (p.y < base) {
        if (far >= 0.0) {
          float r = smoothstep(0.0, 0.004, base + h.y * 0.92 - (2.0 * base - p.y)) * exp(-(base - p.y) * 9.0);
          col = mix(col, mix(uB, uC, smoothstep(base + h.y * 0.5, base + h.y, 2.0 * base - p.y)), r * 0.24 * (1.0 - far));
        }
        return col;
      }
      float wet = base + h.x + jag(p.x, h.y, seed) + 0.0008 * n2(p * 420.0);
      float d = wet - p.y;
      if (d < -0.004 || h.y < 0.004) return col;
      float k = clamp((p.y - base) / max(h.y, 0.02), 0.0, 1.2); // 0 at its feet, 1 at its soft crest
      vec3 ochre = mix(uD, uA, 0.1), green = uB, blue = mix(uC, uB, 0.32) * 0.8;
      // the light, and the strokes' direction (down the flank, leaning out with it)
      float e = 0.03, sl = (bell(p.x + e, a) + bell(p.x + e, b) + bell(p.x + e, c) - bell(p.x - e, a) - bell(p.x - e, b) - bell(p.x - e, c)) / (2.0 * e);
      float lit = sl / (abs(sl) + 1.0);
      float ds = max(base + h.y - p.y, 0.0);
      float s = p.x + clamp(sl, -2.0, 2.0) * 0.22 * min(ds, 0.12) + 0.003 * n2(vec2(p.x * 18.0, ds * 22.0) + seed), cun = 0.0;
      // the layers: their edges the brush's — the blue reaching down the flanks in tongues along the strokes, further
      // on the small peaks, less in the folds between them
      float wig = 0.06 * fbm3(p * vec2(14.0, 30.0) + seed) + 0.03 * n2(p * vec2(150.0, 45.0) + seed) + 0.09 * n2(vec2(s * 70.0, ds * 5.0) + seed);
      float bump = clamp((h.x - h.y) / max(h.y, 0.02), -0.2, 0.2);
      vec3 c0 = mix(ochre, green, smoothstep(0.008, 0.016, p.y - base + wig * 0.12)); // (ochre only along the water's edge)
      c0 = mix(c0, mix(green, blue, 0.5), smoothstep(blueAt - 0.1, blueAt - 0.06, k + wig * 1.3 + bump) * 0.6);
      c0 = mix(c0, blue, smoothstep(blueAt - 0.02, blueAt + 0.02, k + wig * 1.4 + bump));
      // lit faces lighter; the shaded ones with indigo laid under the colour (花青)
      c0 *= 1.0 + 0.16 * max(lit, 0.0) * smoothstep(0.0, 0.3, k);
      c0 = mix(c0, vec3(0.1, 0.18, 0.24), max(-lit, 0.0) * 0.32 * smoothstep(0.0, 0.25, k));
      for (int j = 0; j < 2; j++) {
        float fj = float(j), sp = mix(0.0038, 0.0061, fj), kk = s / sp + seed * 7.0 + fj * 3.3;
        float id = floor(kk), fr = fract(kk) - 0.5 - (hash(vec2(id, seed + fj)) - 0.5) * 0.5;
        float w = 0.08 + 0.13 * hash(vec2(id, 3.0 + fj));
        float st = 0.001 + 0.03 * hash(vec2(id, 5.0 + fj)) * hash(vec2(id, 6.0)), len = 0.02 + 0.09 * hash(vec2(id, 7.0 + fj));
        float along = smoothstep(st, st + 0.005, ds) * smoothstep(st + len, st + len * 0.5, ds);
        float dry = smoothstep(-0.3, 0.35, n2(vec2(id * 3.7, ds * 170.0 + fj * 9.0)));
        cun = max(cun, smoothstep(w, w * 0.3, abs(fr)) * along * dry * step(0.25 - 0.2 * max(-lit, 0.0), hash(vec2(id, 9.0 + fj))) * (0.5 + 0.5 * hash(vec2(id, 11.0))));
      }
      c0 = mix(c0, mix(green, vec3(0.05, 0.1, 0.11), 0.6), cun * 0.62 * (1.0 - clear) * smoothstep(0.02, 0.15, k));
      // the pigment: coarse grains, a few catching the light on the blue
      c0 *= 0.95 + 0.05 * n2(p * 700.0) + 0.04 * n2(p * 1500.0) + 0.05 * fbm3(p * vec2(22.0, 46.0) + seed);
      c0 += vec3(0.12, 0.16, 0.2) * pow(max(n2(p * 1700.0 + seed), 0.0), 7.0) * 3.0 * smoothstep(blueAt, blueAt + 0.1, k + wig);
      c0 = mix(c0, uA, clear);
      float inside = smoothstep(-px * 0.7, px * 0.7, d) * smoothstep(0.0, 0.004, p.y - base);
      col = mix(col, c0, inside);
      COVER = max(COVER, inside * (1.0 - clear));
      // the outline: its weight changing along it, broken here and there
      float lw = px * (0.8 + 1.5 * smoothstep(-0.4, 0.6, n2(vec2(p.x * 26.0, seed))));
      float line = smoothstep(lw, lw * 0.35, abs(d - lw * 0.6)) * smoothstep(-0.6, 0.1, n2(vec2(p.x * 170.0, seed * 3.0)));
      col = mix(col, vec3(0.1, 0.14, 0.14), line * 0.85 * (1.0 - clear));
      // moss dots in clusters on the high places
      if (d < 0.02 && clear < 0.5) {
        float cw = 0.013, cell = floor(p.x / cw), dots = 0.0;
        for (int kq = -1; kq <= 1; kq++) {
          float ci = cell + float(kq);
          if (hash(vec2(ci, seed + 3.0)) < 0.62) continue;
          float cx = (ci + 0.5) * cw;
          vec2 hh = peaks(cx, a, b, c, seed);
          if (hh.x < hh.y * 0.95 || hh.y < 0.04) continue;
          for (int m = 0; m < 4; m++) {
            vec2 o = (hash22(vec2(ci, float(m) + seed)) - 0.5) * vec2(0.01, 0.005);
            float r = length(p - vec2(cx + o.x, base + hh.x + jag(cx + o.x, hh.y, seed) - 0.0028 + o.y));
            dots = max(dots, smoothstep(px * 2.4, px * 1.1, r) * step(float(m), 3.0 * hash(vec2(ci, 2.0)) + 0.5));
          }
        }
        col = mix(col, vec3(0.07, 0.13, 0.11), dots * 0.9);
      }
      return col;
    }
    // a grove on a range's lower slopes: small trees in clusters (点叶) — a pine's flat tiers or a broadleaf's dabs, each
    // on its stem — standing on the slope above the water
    vec3 grove(vec3 col, vec2 p, float base, vec4 a, vec4 b, vec4 c, float seed, float lo, float hi){
      if (p.y < base + lo - 0.002 || p.y > base + hi + 0.03) return col;
      float px = 1.0 / uR.y, cw = 0.016, cell = floor(p.x / cw), ink = 0.0;
      for (int kq = -1; kq <= 1; kq++) {
        float ci = cell + float(kq);
        if (hash(vec2(ci, seed + 21.0)) < 0.4) continue;
        for (int m = 0; m < 3; m++) {
          vec2 r2 = hash22(vec2(ci * 1.3 + float(m), seed + 5.0));
          float tx = (ci + r2.x) * cw;
          float ty = base + mix(lo, hi, r2.y);
          vec2 hh = peaks(tx, a, b, c, seed);
          if (base + hh.y * 0.9 < ty + 0.02) continue; // (only on the slope, below its crest)
          float sz = 0.011 + 0.008 * hash(vec2(ci, float(m) + 7.0));
          vec2 q = (p - vec2(tx, ty)) / sz;
          float stem = smoothstep(0.07, 0.03, abs(q.x)) * step(0.0, q.y) * step(q.y, 0.6);
          float crown;
          if (hash(vec2(ci, float(m) + 9.0)) < 0.5) {
            // a pine: three flat tiers
            crown = 0.0;
            for (int l = 0; l < 3; l++) { float y = 0.35 + 0.22 * float(l); crown = max(crown, smoothstep(1.0, 0.8, length((q - vec2(0.0, y)) / vec2(0.42 - 0.1 * float(l), 0.1)))); }
          } else {
            // a broadleaf: a round head of dabs
            crown = smoothstep(1.0, 0.8, length((q - vec2(0.0, 0.62)) / vec2(0.38, 0.34)) + 0.35 * n2(q * 9.0 + ci));
          }
          ink = max(ink, max(stem, crown * (0.8 + 0.2 * n2(q * 14.0))));
        }
      }
      return mix(col, mix(uB, vec3(0.05, 0.1, 0.09), 0.62), ink * 0.92);
    }
    // a house by the water: white walls, a dark roof with turned-up eaves
    float house(vec2 q, float s){
      q /= s;
      float wall = step(abs(q.x), 0.5) * step(0.0, q.y) * step(q.y, 0.45);
      float roof = step(abs(q.x), 0.72 - (q.y - 0.45) * 0.9) * step(0.45, q.y) * step(q.y, 0.78) + smoothstep(0.06, 0.0, abs(q.y - 0.45 - 0.06 * pow(abs(q.x) / 0.72, 3.0))) * step(abs(q.x), 0.8);
      return wall + 2.0 * min(roof, 1.0);
    }
    // the river's waves: rows of fish-scale arcs (網巾水), finer further off, drifting; \`on\`: where the water shows
    float waves(vec2 p, float t, float top){
      float dep = top - p.y, px = 1.0 / uR.y;
      if (dep < 0.006) return 0.0;
      float rh = 0.0038 * (1.0 + dep * 1.8), row = floor(p.y / rh), v = fract(p.y / rh);
      float per = rh * (4.0 + 1.5 * hash(vec2(row, 2.0))), u = p.x / per + hash(vec2(row, 1.0)) * 3.0 + t * 0.012 * (mod(row, 2.0) - 0.5);
      float f = fract(u) * 2.0 - 1.0, arc = 0.25 + 0.4 * (1.0 - f * f);
      float th = px * 0.7 / rh;
      float line = smoothstep(th, th * 0.3, abs(v - arc)) * step(0.45, hash(vec2(floor(u), row))) * (0.5 + 0.5 * hash(vec2(floor(u) * 3.0, row)));
      return line * smoothstep(0.006, 0.03, dep);
    }
    // a cloud at b.xy (half width b.z): five lobes joined, a flat foot, outlined in a line of changing weight, a curl in
    // each lobe, white at the top shading a little under it
    vec3 cloud(vec3 col, vec2 p, vec3 b, float seed){
      if (abs(p.x - b.x) > b.z * 1.3 || abs(p.y - b.y) > b.z * 0.7) return col;
      float px = 1.0 / uR.y, d = 1e3, curl = 0.0;
      for (int i = 0; i < 5; i++) {
        float fi = float(i), u = fi / 4.0 - 0.5;
        float r = b.z * (0.27 + 0.12 * hash(vec2(fi, seed))) * (1.0 - 0.38 * abs(u) * 2.0);
        vec2 c = vec2(b.x + u * 2.0 * b.z * 0.72, b.y + r * 0.3);
        float di = length(p - c) - r, k = b.z * 0.08, hh = clamp(0.5 + 0.5 * (di - d) / k, 0.0, 1.0);
        d = mix(di, d, hh) - k * hh * (1.0 - hh);
        float cw = px * (0.6 + 0.6 * smoothstep(-1.0, 1.0, (p.x - c.x) / r));
        curl = max(curl, smoothstep(cw, cw * 0.3, abs(length(p - c - vec2(r * 0.15, 0.0)) - r * 0.5)) * step(c.y, p.y) * step(p.x, c.x + r * 0.15));
      }
      d = max(d, b.y - b.z * 0.06 - p.y);
      float inside = smoothstep(px, -px, d);
      col = mix(col, mix(uA * 1.05, mix(uA, uC, 0.25), smoothstep(b.y + b.z * 0.3, b.y - b.z * 0.05, p.y) * 0.6), inside * 0.95);
      vec3 line = mix(uA, uB, 0.62);
      float lw = px * (0.7 + 0.9 * smoothstep(-0.5, 0.5, n2(p * 90.0 + seed)));
      col = mix(col, line, smoothstep(lw, lw * 0.3, abs(d)) * 0.75);
      return mix(col, line, curl * inside * 0.5);
    }
    // a small sail, at q (its waterline at y = 0)
    float sail(vec2 q){
      float hull = step(abs(q.x), 0.022) * step(-0.004 * (1.0 - pow(q.x / 0.022, 2.0)) - 0.0008, q.y) * step(q.y, 0.001);
      float s = step(0.0, q.y) * step(q.y, 0.04) * step(q.x, 0.003) * step(-0.016 + q.y * 0.32, q.x);
      return max(hull, s);
    }`,
  // drawn once: the silk, the hills in their colours and strokes, the groves, the houses, the still water and its
  // reflections (keepA: where the water shows, for what moves on it)
  still: `COVER = 0.0;
    col = silk(p, uv);
    // the sky: a faint warm glow low on the right
    col = mix(col, mix(uA, uD, 0.25), exp(-pow(length((p - vec2(0.5, 0.05)) * vec2(0.6, 1.4)), 2.0) * 6.0) * 0.25);
    // the far ranges, pale, half gone into the silk, on the far shore
    col = range(col, p, -0.05, vec4(0.62, 0.26, 0.17, 1.8), vec4(0.2, 0.2, 0.1, 1.7), vec4(-0.25, 0.3, 0.13, 1.6), 1.0, 0.6, 0.55);
    // the river, wide, from the far shore down: the silk tinted
    float wet = smoothstep(0.0, 0.03, -0.05 - p.y);
    col = mix(col, mix(uA, uC, 0.22), wet);
    COVER = 0.0;
    // the main massif (right of centre): tall peaks, steep, rising from the water; a ridge in front of it
    vec4 m1 = vec4(0.3, 0.13, 0.5, 2.4), m2 = vec4(0.53, 0.11, 0.35, 2.2), m3 = vec4(0.1, 0.1, 0.24, 2.0);
    col = range(col, p, -0.19, m1, m2, m3, 4.0, 0.0, 0.7);
    vec4 f1 = vec4(0.16, 0.12, 0.16, 1.8), f2 = vec4(0.44, 0.1, 0.12, 1.8), f3 = vec4(0.62, 0.08, 0.08, 1.8);
    col = range(col, p, -0.19, f1, f2, f3, 6.0, 0.0, 0.8);
    col = grove(col, p, -0.19, f1, f2, f3, 6.0, 0.008, 0.07);
    // the left massif, a ridge in front of it
    col = range(col, p, -0.22, vec4(-0.58, 0.15, 0.36, 2.3), vec4(-0.36, 0.1, 0.2, 2.0), vec4(-0.84, 0.13, 0.24, 2.0), 8.0, 0.0, 0.7);
    vec4 g1 = vec4(-0.46, 0.13, 0.13, 1.8), g2 = vec4(-0.7, 0.09, 0.1, 1.8), g3 = vec4(-0.24, 0.08, 0.07, 1.8);
    col = range(col, p, -0.22, g1, g2, g3, 10.0, 0.0, 0.82);
    col = grove(col, p, -0.22, g1, g2, g3, 10.0, 0.008, 0.06);
    // two houses by the water at the main massif's foot
    for (int i = 0; i < 2; i++) {
      vec2 hq = p - vec2(0.36 + 0.03 * float(i), -0.19 + 0.003 * float(i));
      float hs = house(hq, 0.012 - 0.002 * float(i));
      col = mix(col, mix(uA * 1.04, vec3(0.2, 0.22, 0.24), step(1.5, hs)), min(hs, 1.0));
      COVER = max(COVER, min(hs, 1.0));
    }
    // the near bank (lower left): low hills, ochre and green, the darkest, pines on it
    vec4 n1 = vec4(-0.6, 0.3, 0.17, 1.7), n2_ = vec4(-0.2, 0.16, 0.08, 1.6), n3 = vec4(0.0, 0.1, 0.0, 2.0);
    col = range(col, p, -0.5, n1, n2_, n3, 12.0, -1.0, 1.5);
    col = grove(col, p, -0.5, n1, n2_, n3, 12.0, 0.04, 0.15);
    keepA = wet * (1.0 - COVER);`,
  body: `// blue and green mountains (青绿山水) on old silk: a river between, its waves in fine lines, a sail on it
    vec4 S = texture2D(uS, uv);
    col = S.rgb;
    // on the water: the reflections tremble (the still picture read a little aside), the waves drift
    if (S.a > 0.02) {
      float dep = -0.05 - p.y;
      vec2 o = vec2((0.0012 + dep * 0.006) * sin(p.y * 240.0 / (0.3 + dep * 2.0) + t * 0.9), 0.0);
      vec4 R = texture2D(uS, uv + o * vec2(uR.y / uR.x, 1.0));
      col = mix(col, R.rgb, S.a * step(0.5, R.a));
      col = mix(col, mix(uC, vec3(0.16, 0.26, 0.3), 0.45), waves(p, t, -0.05) * 0.26 * S.a);
    }
    // three clouds by the slopes, drifting a little (勾云)
    col = cloud(col, p, vec3(0.52 + 0.03 * sin(t * 0.02), -0.08, 0.11), 1.0);
    col = cloud(col, p, vec3(-0.4 + 0.03 * sin(t * 0.017 + 2.0), -0.035, 0.085), 2.0);
    col = cloud(col, p, vec3(0.08 + 0.04 * sin(t * 0.013 + 4.0), 0.12, 0.06), 3.0);
    // a skein of geese, far off, crossing
    for (int i = 0; i < 6; i++) {
      float fi = float(i), side = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0, rank = floor((fi + 1.0) / 2.0);
      vec2 g = p - vec2(1.1 - mod(t * 0.006, 2.4) + rank * 0.022, 0.3 + side * rank * 0.012 + 0.002 * sin(t * 0.5 + fi));
      float w = abs(g.x), th = mix(0.0013, 0.0005, clamp(w / 0.006, 0.0, 1.0));
      col = mix(col, vec3(0.2, 0.2, 0.2), smoothstep(th, th * 0.3, abs(g.y - w * (0.5 + 0.3 * sin(t * 4.0 + fi)))) * step(w, 0.006) * 0.65);
    }
    // a sail on the river (only where its waterline is on open water: it goes behind the near bank)
    vec2 sq = p - vec2(0.8 - mod(t * 0.004, 1.8), -0.3);
    float on = step(0.5, texture2D(uS, vec2(uv.x, uv.y - sq.y)).a);
    col = mix(col, vec3(0.93, 0.91, 0.85), sail(sq) * step(0.0, sq.y) * 0.95 * on);
    col = mix(col, vec3(0.25, 0.22, 0.2), sail(sq) * step(sq.y, 0.0) * 0.9 * on);` },
  moonlit: { fps: 20, fn: `${HILLS}
    const vec2 MOON = vec2(0.42, 0.19);
    const float MR = 0.085;
    const float HZ = -0.15; // the far shore: the water below it
    float COVER;
    // the sky: deep blue thinning to the horizon, faintly uneven (night air), a fine grain
    vec3 sky(vec2 p){
      vec3 c = mix(mix(uB, uC, 0.06), uA, smoothstep(-0.12, 0.5, p.y));
      c *= 0.97 + 0.05 * fbm3(p * 2.5 + 3.0);
      return c * (0.99 + 0.02 * n2(p * 900.0));
    }
    // the moon: its seas at two scales, its limb a little darker, warm in its middle;
    // round it a glow and a faint ring (月晕)
    vec3 moon(vec3 c, vec2 p){
      vec2 q = p - MOON; float md = length(q);
      c += uC * (exp(-md * 4.5) * 0.12 + exp(-md * 14.0) * 0.22) + uC * 0.035 * exp(-pow((md - MR * 3.6) / (MR * 0.5), 2.0));
      if (md > MR + 0.004) return c;
      vec2 u = q / MR;
      float seas = fbm3(u * 2.2 + 2.0) + 0.5 * fbm3(u * 5.0 + 7.0);
      float tone = 0.97 + 0.04 * smoothstep(0.15, -0.25, seas) - 0.11 * smoothstep(0.05, 0.4, seas);
      tone -= 0.03 * smoothstep(0.2, 0.6, fbm3(u * 11.0 + 4.0)); // (finer shading in the highlands)
      tone *= 1.0 - 0.12 * pow(md / MR, 4.0);
      vec3 m = uC * tone * mix(vec3(1.0), vec3(1.03, 1.0, 0.94), smoothstep(0.8, 0.0, md / MR));
      return mix(c, m, smoothstep(MR, MR - 0.0018, md));
    }
    // a range at the crest \`top\`: \`ink\` under its crest, fading over \`fall\` into the mist (how much: \`mist\`), faintly
    // textured (trees too far to see one by one), its crest caught by the moon's light where it faces it
    vec3 ridge(vec3 c, vec2 p, float top, vec3 ink, float fall, float mist){
      float d = top - p.y, px = 1.0 / uR.y;
      vec3 haze = mix(uB, uC, 0.16) * 1.05;
      vec3 body = mix(ink, haze, smoothstep(0.0, fall, d) * mist) * (0.96 + 0.06 * n2(vec2(p.x * 300.0, p.y * 120.0)));
      float inside = smoothstep(-px, px, d);
      c = mix(c, body, inside);
      COVER = max(COVER, inside);
      return c + uC * exp(-pow(d / (px * 1.2), 2.0)) * step(0.0, d + px) * exp(-length(p - MOON) * 6.0) * 0.28;
    }
    // the trees on the nearest ridge, one by one: pines (tiers narrowing upward) and round-headed trees, each its own height
    float trees(float x){
      float cw = 0.0052, h = 0.0;
      for (int k = -1; k <= 1; k++) {
        float ci = floor(x / cw) + float(k), r = hash(vec2(ci, 3.0));
        if (r < 0.25) continue;
        float cx = (ci + 0.5 + (hash(vec2(ci, 4.0)) - 0.5) * 0.5) * cw, ht = 0.006 + 0.012 * hash(vec2(ci, 5.0)), f = (x - cx) / (cw * (0.9 + 0.8 * hash(vec2(ci, 6.0))));
        float y;
        if (r < 0.7) { float tier = fract(clamp(1.0 - abs(f) * 2.0, 0.0, 1.0) * 3.0); y = ht * clamp(1.0 - abs(f) * 2.0 - 0.08 * tier, 0.0, 1.0); }
        else y = ht * 0.75 * sqrt(max(1.0 - pow(f * 1.6, 2.0), 0.0)) + ht * 0.25 * step(abs(f), 0.06);
        h = max(h, y);
      }
      return h;
    }
    // a line from a to b, \`w0\` wide at a and \`w1\` at b
    float stroke(vec2 q, vec2 a, vec2 b, float w0, float w1){
      vec2 ab = b - a; float u = clamp(dot(q - a, ab) / dot(ab, ab), 0.0, 1.0);
      float w = mix(w0, w1, u);
      return smoothstep(w, w * 0.45, length(q - a - ab * u));
    }
    // a pine bough reaching in (q: along it from the edge of the picture): a crooked branch thinning as it goes, knots and
    // bark on it, twigs off it, clumps of foliage in splashed ink at their ends and on them
    float bough(vec2 q){
      if (q.x < -0.25 || q.x > 0.72 || q.y < -0.09 || q.y > 0.22) return 0.0;
      float px = 1.0 / uR.y, b = 0.0;
      float bx = q.x, by = 0.06 - 0.12 * bx + 0.25 * bx * bx - 0.03 * sin(bx * 9.0);
      float w = mix(0.017, 0.0032, clamp(bx / 0.62, 0.0, 1.0)) * (1.0 + 0.25 * n2(vec2(bx * 30.0, 1.0)));
      float across = (q.y - by) / w;
      float branch = smoothstep(1.0, 0.75, abs(across)) * step(-0.25, bx) * step(bx, 0.62);
      // its bark: the branch lighter in its middle where the moon is behind it, scaled
      b = max(b, branch * (0.9 + 0.1 * smoothstep(0.3, 0.7, n2(vec2(bx * 160.0, across * 1.5)))));
      for (int i = 0; i < 9; i++) {
        float fi = float(i), tx = 0.05 + 0.066 * fi, ty = 0.06 - 0.12 * tx + 0.25 * tx * tx - 0.03 * sin(tx * 9.0);
        float side = mod(fi, 2.0) < 0.5 ? -1.0 : 1.0;
        vec2 a = vec2(tx, ty), e = a + vec2(0.03 + 0.025 * hash(vec2(fi, 1.0)), side * (0.026 + 0.02 * hash(vec2(fi, 2.0))));
        vec2 m = mix(a, e, 0.5) + vec2(0.0, side * 0.004);
        float tw = mix(0.0028, 0.0018, fi / 8.0);
        b = max(b, max(stroke(q, a, m, tw, tw * 0.75), stroke(q, m, e, tw * 0.75, tw * 0.4)));
        // its foliage: clumps of splashed ink (dark against the moon, soft at their edges), a big one at its end and a
        // smaller one on it
        b = over(b, min(foliage(q, e + vec2(0.006, side * 0.003), vec2(0.05 - 0.0018 * fi, 0.016), fi * 2.3) * 2.8, 1.0));
        b = over(b, min(foliage(q, e + vec2(-0.012, side * 0.013), vec2(0.032, 0.011), fi * 2.3 + 0.5) * 2.6, 1.0) * 0.95);
        b = over(b, min(foliage(q, mix(a, e, 0.5) + vec2(0.0, side * 0.01), vec2(0.026, 0.01), fi * 2.3 + 0.9) * 2.4, 1.0) * 0.92);
      }
      return b;
    }`,
  // drawn once: the sky, the moon, the hills in their haze (keepA: the open sky, for the stars and the clouds)
  still: `COVER = 0.0;
    col = moon(sky(p), p);
    float x = p.x;
    vec2 h = mass(x, vec4(-0.3, 0.45, 0.19, 1.6), 1.0) + mass(x, vec4(0.78, 0.35, 0.13, 1.7), 2.0);
    col = ridge(col, p, -0.1 + h.x, mix(uB * 1.2, uC * 0.45, 0.15), 0.1, 0.55);
    h = mass(x, vec4(-0.62, 0.3, 0.2, 1.8), 4.0) + mass(x, vec4(0.12, 0.28, 0.12, 1.6), 5.0);
    col = ridge(col, p, -0.13 + h.x, mix(uB * 0.8, uD, 0.25), 0.09, 0.4);
    h = mass(x, vec4(-0.85, 0.28, 0.09, 1.6), 7.0) + mass(x, vec4(-0.38, 0.2, 0.05, 1.6), 8.0) + mass(x, vec4(0.62, 0.22, 0.035, 1.6), 9.0);
    col = ridge(col, p, -0.145 + h.x + trees(x) * smoothstep(0.004, 0.02, h.y), uD, 0.05, 0.15);
    keepA = (1.0 - COVER) * step(HZ, p.y);`,
  body: `// a moon over still water, framed by a pine bough; thin clouds drift across it, its light trembles on the water
    vec4 S = texture2D(uS, uv);
    if (p.y > HZ) {
      col = S.rgb;
      float md = length(p - MOON);
      // stars in the open sky, twinkling, none in the moon's glare
      vec2 g = p * 110.0, id = floor(g), f = fract(g) - 0.5; float r = hash(id);
      col += vec3(0.85, 0.88, 1.0) * step(0.993, r) * smoothstep(0.1, 0.0, length(f - (hash22(id) - 0.5) * 0.6)) * (0.55 + 0.45 * sin(t * (0.4 + r * 1.6) + r * 40.0)) * smoothstep(0.0, 0.25, p.y) * smoothstep(0.12, 0.35, md) * S.a;
      // thin clouds drifting across: long wisps, silver at their edges where the moon is behind them
      float band = smoothstep(0.06, 0.13, p.y) * smoothstep(0.3, 0.17, p.y);
      if (band > 0.0) {
        float cl = fbm(vec2(p.x * 1.6 - t * 0.012, p.y * 9.0 + 3.0)) + 0.25 * fbm3(vec2(p.x * 6.0 - t * 0.02, p.y * 40.0));
        float cloud = smoothstep(0.05, 0.5, cl) * band * S.a;
        col = mix(col, mix(uB * 1.25, uC * 0.85, exp(-md * 6.0)), cloud * 0.55);
        col += uC * smoothstep(0.3, 0.42, cl) * smoothstep(0.55, 0.42, cl) * band * exp(-md * 9.0) * 0.4 * S.a;
      }
    } else {
      // the water: the night above read upside down, trembling; the moon's path in glints
      float dep = HZ - p.y;
      float wob = (0.0012 + dep * 0.022) * sin(p.y * 170.0 / (dep * 3.0 + 0.25) + t * 1.0) + (0.0015 + dep * 0.012) * n2(vec2(p.x * 5.0, p.y * 70.0 - t * 0.4));
      col = texture2D(uS, vec2(uv.x + wob * uR.y / uR.x, 2.0 * (HZ + 0.5) - uv.y)).rgb * 0.52;
      float lane = exp(-pow((p.x - MOON.x - wob) / (0.018 + dep * 0.2), 2.0));
      float glint = smoothstep(0.42, 0.88, n2(vec2(p.x * 14.0 + t * 0.05, p.y * 360.0 / (dep * 1.6 + 0.2) - t * 0.7)));
      float spark = pow(max(n2(vec2(p.x * 90.0 + t * 0.3, p.y * 700.0 / (dep * 1.6 + 0.2) - t * 1.3)), 0.0), 6.0) * 3.0;
      col += uC * lane * (0.1 + glint * 0.85 + spark * 0.6) * smoothstep(0.0, 0.012, dep);
      col = mix(col, uA * 0.7, smoothstep(0.1, 0.35, dep) * 0.4);
    }
    // low mist drifting along the far shore, faintly lit
    float fz = exp(-pow((p.y - HZ - 0.012) / 0.03, 2.0));
    if (fz > 0.01) col = mix(col, mix(uB, uC, 0.22), smoothstep(0.25, 0.75, fbm(vec2(p.x * 2.0 - t * 0.015, p.y * 14.0 + 5.0)) + 0.1 * n2(vec2(p.x * 20.0 - t * 0.05, p.y * 90.0))) * fz * 0.45);
    // a crane crossing, now and then, by the moon
    float ct = mod(t, 90.0);
    vec2 cq = p - vec2(1.0 - ct * 0.024, 0.215 + 0.01 * sin(ct * 0.4));
    float flap = sin(t * 3.0) * 0.6, cw = mix(0.0016, 0.0005, clamp(abs(cq.x) / 0.02, 0.0, 1.0));
    float crane = smoothstep(cw, cw * 0.35, abs(cq.y - abs(cq.x) * flap * 0.8)) * step(abs(cq.x), 0.02) + smoothstep(0.003, 0.0018, length(cq * vec2(0.35, 1.0)));
    col = mix(col, uD, clamp(crane, 0.0, 1.0) * 0.92);
    // the pine bough, swaying a little, reaching in from the right across the moon's lower half
    float pr = uR.x / uR.y;
    vec2 bq = p - vec2(0.5 * pr + 0.02, 0.05);
    bq.x = -bq.x;
    bq.y -= 0.01 * sin(t * 0.5) * bq.x;
    col = mix(col, uD * 0.55, bough(bq) * 0.98);` },
  wash: { body: `// ink opening in water: two plumes with darker rims and fine threads, a touch of vermilion, white paper around
    vec2 q = p * 1.2;
    vec2 w = vec2(fbm(q + vec2(0.0, t * 0.015)), fbm(q + vec2(3.7, 1.1) - t * 0.012));
    vec2 r = vec2(fbm(q + 2.0 * w + vec2(t * 0.01, 1.3)), fbm(q + 2.0 * w + vec2(5.1, -t * 0.009)));
    float f = fbm(q + 2.2 * r);
    float mask = exp(-pow(length((p - vec2(0.12, 0.06)) * vec2(0.8, 1.25)) * 2.1, 2.0)) + 0.7 * exp(-pow(length(p - vec2(-0.55, -0.26)) * 2.8, 2.0));
    float v = f + mask * 0.5 - 0.33;
    float body = smoothstep(0.0, 0.22, v), core = smoothstep(0.12, 0.42, v);
    float rim = exp(-pow(v * 16.0, 2.0)) * smoothstep(-0.06, 0.0, v);
    float thread = pow(1.0 - abs(n2(q * 5.0 + 3.0 * r)), 8.0) * smoothstep(-0.12, 0.02, v) * (1.0 - body);
    col = uA * (0.975 + 0.03 * fbm3(p * vec2(3.0, 40.0)));
    col = mix(col, uC, body * 0.5);
    col = mix(col, uB, core * 0.88);
    col = mix(col, uB, rim * 0.3 + thread * 0.25);
    float red = smoothstep(0.1, 0.35, fbm(q * 1.3 + 2.0 * r + vec2(8.0, 3.0)) + exp(-pow(length(p - vec2(0.62, -0.3)) * 5.0, 2.0)) * 0.5 - 0.25);
    col = mix(col, uD, red * (1.0 - core) * 0.6);` },
}

/** The wallpapers a scene here draws (desktop.js's list is checked against it). */
export const SCENE_IDS = Object.keys(SCENES)

// (`derivatives: true`: the scene reads how fast a value changes across the screen — dFdx, dFdy, fwidth — for relief and lines)
// A scene with `tex: { uName: () => ({ width, height, data }) }`: a picture of its own data (one byte a pixel, read as .r;
// made once, when the scene is first drawn) the scene reads as `uniform sampler2D uName` — an interactive desk's islands.
// A scene with a `still` part: that part is drawn once (for this size, these colours) into a picture the scene's body
// reads each frame as uS (its alpha a mask the still part may set: `keepA`), so a detailed picture costs one frame, and each
// frame after it only what moves. `still: true` here: the still part's program.
const frag = (s, still = false) => `${s.derivatives ? '#extension GL_OES_standard_derivatives : enable\n' : ''}${LIB}${s.still && !still ? 'uniform sampler2D uS;\n' : ''}${Object.keys(s.tex || {}).map(n => `uniform sampler2D ${n};\n`).join('')}${s.fn || ''}
void main(){
  vec2 uv = gl_FragCoord.xy / uR, p = (gl_FragCoord.xy - 0.5 * uR) / uR.y; float t = uT; vec3 col = vec3(0.0);${still ? ' float keepA = 1.0;' : ''}
  ${still ? s.still : s.body}
  col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0 * 2.0; // dither: no banding in the soft gradients
  gl_FragColor = vec4(col, ${still ? 'keepA' : '1.0'});
}`
const VERT = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }'
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
export const wallOf = id => WALLPAPERS.find(w => w.id === id) || WALLPAPERS[0]
/** Where a scene's colours make a still picture (no WebGL, or the plain wallpaper's preview). */
export const fallbackOf = w => (w.c.length ? `linear-gradient(160deg, ${w.c[1]}, ${w.c[0]} 70%)` : '')
/** The scenes that draw data (the agents at work): set({ data }) feeds them. */
export const DATA_SCENES = new Set(Object.entries(SCENES).filter(([, x]) => x.data).map(([id]) => id))
// what a data scene is given each frame (its fn declares them): tasks, their second halves, agents, links, the counts
// (uCS, uCL: a scene's own figures — the star map's constellations: stars x, y, size, kind; lines x1, y1, x2, y2)
const DATA = [['uTask', 8], ['uTaskB', 8], ['uStar', 16], ['uStarB', 16], ['uLink', 8], ['uLinkB', 8], ['uMark', 24], ['uMarkB', 24], ['uCS', 128], ['uCL', 128]]
/**
 * How sharp a scene may draw: the share of the screen's pixels (0.5–1) at which one frame takes at most this many
 * milliseconds of the GPU (a third of a 30-frames budget, so the page itself stays smooth). Measured once a scene and a
 * screen size.
 */
const SHARP = { ms: 9, min: 0.5 }

/** WebGL on a canvas, each scene's program compiled when first drawn: draw(wallpaper, t, W, H) → whether it drew. null: no WebGL here. */
function scene(canvas, sceneOf = id => SCENES[id]) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true, powerPreference: 'low-power' })
  if (!gl) return null
  const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s }
  const vert = sh(gl.VERTEX_SHADER, VERT)
  const programs = new Map() // id → { pr, u, still? } | null (it did not compile here)
  const link = (src, names) => {
    const pr = gl.createProgram()
    gl.attachShader(pr, vert); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, src)); gl.linkProgram(pr)
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr))
    return { pr, loc: gl.getAttribLocation(pr, 'a'), u: Object.fromEntries(names.map(n => [n, gl.getUniformLocation(pr, n)])) }
  }
  const NAMES = ['uR', 'uT', 'uK', 'uP', 'uA', 'uB', 'uC', 'uD', 'uN', 'uV', ...DATA.map(([n]) => n)]
  const program = w => {
    if (programs.has(w.id)) return programs.get(w.id)
    let out = null
    try {
      const sc = sceneOf(w.id)
      if (!sc) throw new Error(`no scene ${w.id}`)
      if (sc.derivatives && !gl.getExtension('OES_standard_derivatives')) throw new Error('no OES_standard_derivatives here')
      const texNames = Object.keys(sc.tex || {})
      out = link(frag(sc), [...NAMES, 'uS', ...texNames])
      if (sc.still) out.still = link(frag(sc, true), [...NAMES, ...texNames])
      // its own data pictures, on texture units 1, 2… (0 is the still part's)
      const tex = texNames.map((name, i) => {
        const d = sc.tex[name](), t = gl.createTexture()
        gl.activeTexture(gl.TEXTURE1 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, d.width, d.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, d.data)
        ;[[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v))
        return { name, t, unit: 1 + i }
      })
      out.tex = tex
      if (out.still) out.still.tex = tex
    } catch (e) { console.warn(`ruyix wallpaper ${w.id}:`, e.message) }
    programs.set(w.id, out)
    return out
  }
  // the still parts drawn: `${id} ${W}×${H} ${scale} ${colours}` → { tex, fb } (the last few kept)
  const stills = new Map()
  const stillOf = (w, pg, W, H, scale) => {
    const key = `${w.id} ${W}x${H} ${scale} ${w.c.join()}`
    if (stills.has(key)) return stills.get(key).tex
    const tex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    ;[[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v))
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    run(pg.still, w, 0, W, H, 0, null, scale)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    stills.set(key, { tex, fb })
    for (const [k, v] of stills) { if (stills.size <= 3) break; if (k !== key) { gl.deleteTexture(v.tex); gl.deleteFramebuffer(v.fb); stills.delete(k) } }
    return tex
  }
  /** One program over the whole target (the canvas, or a still part's picture). */
  const run = (pg, w, t, W, H, k, data, scale) => {
    gl.useProgram(pg.pr); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(pg.loc); gl.vertexAttribPointer(pg.loc, 2, gl.FLOAT, false, 0, 0)
    gl.viewport(0, 0, W, H); gl.uniform2f(pg.u.uR, W, H); gl.uniform1f(pg.u.uT, t); gl.uniform1f(pg.u.uK, k); gl.uniform1f(pg.u.uP, scale)
    ;['uA', 'uB', 'uC', 'uD'].forEach((k, i) => gl.uniform3fv(pg.u[k], rgb(w.c[i])))
    // a data scene: what it draws this frame (none: nothing but its ground)
    if (pg.u.uN) {
      gl.uniform3fv(pg.u.uN, data?.n || [0, 0, -1])
      for (const [n, len] of DATA) if (pg.u[n]) gl.uniform4fv(pg.u[n], data?.[n] || new Float32Array(len * 4))
    }
    // a scene one looks round (an interactive desk): where the view is and how far out (x, y, how much of the world a screen's height shows)
    if (pg.u.uV) gl.uniform3fv(pg.u.uV, data?.uV || [0, 0, 1])
    for (const x of pg.tex || []) { gl.activeTexture(gl.TEXTURE0 + x.unit); gl.bindTexture(gl.TEXTURE_2D, x.t); gl.uniform1i(pg.u[x.name], x.unit) }
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
  return {
    gl,
    draw(w, t, W, H, k = 0, data = null, scale = 1) {
      const pg = program(w)
      if (!pg) return false
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H }
      if (pg.still) {
        const tex = stillOf(w, pg, W, H, scale)
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.useProgram(pg.pr); gl.uniform1i(pg.u.uS, 0)
      }
      run(pg, w, t, W, H, k, data, scale)
      return true
    },
    /** How long one frame of this scene takes the GPU at W × H, in ms (the GPU waited for: a measurement, not for every frame). */
    cost(w, t, W, H, k, data, scale) {
      gl.finish()
      const a = performance.now()
      for (let i = 0; i < 3; i++) this.draw(w, t + i / 30, W, H, k, data, scale)
      gl.finish()
      return (performance.now() - a) / 3
    },
  }
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/**
 * The desktop's wallpaper on `canvas` (full window). set({ wallpaper, motion, covered, energy }) as they change; destroy()
 * at the end. `covered`: a window covers most of it — a live scene slows to a few frames a second. `energy` (0–1): how
 * lively the agent is (the intelligence scenes answer it; eased, and drawn at full speed while it is up).
 */
export function createWallpaper(canvas, { scenes = {} } = {}) {
  // a plugin's own scenes beside these (an interactive desk's maps): { id: { fn, body, data, fps, c: [4 colours], tone } }
  const sceneOf = id => scenes[id] || SCENES[id]
  const wallFor = id => (scenes[id] ? { id, live: scenes[id].live !== false, c: scenes[id].c, tone: scenes[id].tone || 'dark' } : wallOf(id))
  let s = null
  try { s = scene(canvas, sceneOf) } catch { s = null }
  let wall = WALLPAPERS[0], motion = true, covered = false, raf = 0, last = 0, failed = false, energy = 0, k = 0, data = null, fast = false
  const t0 = performance.now(), now = () => (performance.now() - t0) / 1000 + 40
  // the screen's own pixels (the window is the desk), times what this GPU affords for this scene (measured: sharpness)
  const full = () => { const d = Math.min(window.devicePixelRatio || 1, 2); return [Math.max(2, Math.round(window.innerWidth * d)), Math.max(2, Math.round(window.innerHeight * d))] }
  const sharpness = new Map() // `${scene}:${W}x${H}` → share of the pixels
  const dataOf = (t, W, H) => (sceneOf(wall.id)?.data ? data?.(t, W, H) ?? null : null)
  const shareOf = (W, H) => {
    const key = `${wall.id}:${W}x${H}`
    if (!sharpness.has(key)) {
      let share = 1
      try {
        s.draw(wall, now(), W, H, k, dataOf(now(), W, H), W / Math.max(1, window.innerWidth)) // (compiles the scene: not counted)
        const ms = s.cost(wall, now(), W, H, k, dataOf(now(), W, H), W / Math.max(1, window.innerWidth))
        if (ms > SHARP.ms) share = Math.max(SHARP.min, Math.floor(Math.sqrt(SHARP.ms / ms) * 20) / 20)
      } catch { /* measured nothing: full */ }
      sharpness.set(key, share)
    }
    return sharpness.get(key)
  }
  const size = () => { const [W, H] = full(), f = shareOf(W, H); return [Math.max(2, Math.round(W * f)), Math.max(2, Math.round(H * f))] }
  const still = () => !s || !wall.c.length || failed
  const live = () => !still() && wall.live && motion && !reduced() && !document.hidden
  const draw = () => { const [W, H] = size(), t = now(); failed = !s.draw(wall, t, W, H, k, dataOf(t, W, H), W / Math.max(1, window.innerWidth)); if (failed) canvas.dataset.plain = '1' }
  const paint = () => {
    canvas.style.background = fallbackOf(wall)
    failed = false
    canvas.dataset.plain = wall.c.length ? '' : '1'
    if (!still()) draw()
  }
  const frame = ts => {
    raf = 0
    if (still()) return // the wallpaper became a still one (plain) after this frame was asked for
    const lively = energy > 0 || k > 0.005
    if (fast || ts - last > (covered && !lively ? 250 : lively ? 30 : 1000 / (sceneOf(wall.id)?.fps || 30) - 1)) { last = ts; k += (energy - k) * (energy > k ? 0.35 : 0.08); if (k < 0.005) k = 0; draw() }
    if (live()) raf = requestAnimationFrame(frame)
  }
  const go = () => { paint(); if (live() && !raf) raf = requestAnimationFrame(frame) }
  const onResize = () => { if (!still()) draw() }
  window.addEventListener('resize', onResize)
  document.addEventListener('visibilitychange', go)
  return {
    set(next) {
      if (next.wallpaper !== undefined) wall = wallFor(next.wallpaper)
      if (next.motion !== undefined) motion = !!next.motion
      if (next.covered !== undefined) covered = !!next.covered
      if (next.energy !== undefined) energy = Math.max(0, Math.min(1, Number(next.energy) || 0))
      // every frame while one looks round (an interactive desk dragged or zoomed), not only at the scene's own pace
      if (next.fast !== undefined) { fast = !!next.fast; if (fast && live() && !raf) raf = requestAnimationFrame(frame) }
      // a data scene's feed: (t, W, H) → { n: [tasks, agents, hovered], uTask, … } for each frame (null: nothing to draw)
      if (next.data !== undefined) { data = typeof next.data === 'function' ? next.data : null; if (!still() && !live()) draw() }
      if (next.wallpaper === undefined && next.motion === undefined && next.covered === undefined) { if (live() && !raf) raf = requestAnimationFrame(frame); return }
      go()
    },
    /** Draw once now (what a data scene draws changed while it is not moving). */
    redraw() { if (!still() && !live()) draw() },
    destroy() {
      cancelAnimationFrame(raf); raf = 0
      window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', go)
      s?.gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

// one hidden canvas draws every preview (a WebGL context each would run into the browser's limit)
let thumbs
/** A still picture of a wallpaper on a 2D canvas (Settings' choices), as it is `t` seconds in (with the agent's energy `k`). */
export function paintThumb(canvas, id, t = 60, k = 0) {
  const w = wallOf(id), W = canvas.width = canvas.clientWidth * 2 || 240, H = canvas.height = canvas.clientHeight * 2 || 150
  const g = canvas.getContext('2d')
  if (!w.c.length || thumbs === null) return false
  try { thumbs ||= scene(document.createElement('canvas')) } catch { thumbs = null }
  if (!thumbs || !thumbs.draw(w, t, W, H, k)) return false
  g.drawImage(thumbs.gl.canvas, 0, 0)
  return true
}
