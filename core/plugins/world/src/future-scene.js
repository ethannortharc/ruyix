// The future map's ground (未来): a city at night seen from space — districts of street lights thickening round each
// place (sodium orange, whiter in the centres), each district's streets its own way with brighter avenues between them,
// a dark river winding through; highways from the core (the capital) to each place with traffic on them (headlights one
// way, tail lights the other); each place a raised hex platform with its own light, windows lit down its sides; each task
// a holo-ring of its steps, its agents drones on it, the messages between them beams with a packet running along.
// Drawn in world units like scenes.js's maps (the same uniforms: world.jsx gives them each frame).

const DATA = `
uniform vec4 uTask[8], uTaskB[8], uStar[16], uStarB[16], uLink[8], uLinkB[8], uMark[24], uMarkB[24]; uniform vec3 uN, uV;
float ink(float d, float w){ return exp(-pow(d / w, 2.0)); }
float segD(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float u = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0); return length(p - a - ab * u); }
`

export const FUTURE = {
  data: true, fps: 30, tone: 'dark', c: ['#03070f', '#22d3ee', '#f0509a', '#ffb547'],
  fn: `${DATA}
// the agents' colours (claude, codex, dsh/a model, the system, the person) and each place's light
vec3 kindCol(float k){ return k < 0.5 ? vec3(1.0, 0.62, 0.38) : k < 1.5 ? vec3(0.35, 0.95, 0.85) : k < 2.5 ? vec3(0.66, 0.58, 1.0) : k < 3.5 ? vec3(0.62, 0.72, 0.86) : vec3(1.0, 0.76, 0.32); }
vec3 placeCol(float k){ return k < 1.5 ? vec3(0.55, 0.95, 1.0) : k < 2.5 ? uB : k < 3.5 ? uC : k < 4.5 ? uD : k < 5.5 ? vec3(0.62, 0.56, 1.0) : k < 6.5 ? vec3(0.3, 0.95, 0.72) : k < 7.5 ? vec3(0.2, 0.85, 0.9) : k < 8.5 ? vec3(0.35, 0.6, 1.0) : k < 9.5 ? vec3(0.4, 0.95, 0.55) : k < 10.5 ? vec3(0.72, 0.68, 0.95) : k < 11.5 ? vec3(0.82, 0.9, 1.0) : k < 12.5 ? vec3(1.0, 0.42, 0.72) : uB * 0.8; }
// a hexagon with flat top and bottom edges, inradius r (< 0 inside)
float hexD(vec2 p, float r){ p = abs(p); return max(dot(p, vec2(0.8660254, 0.5)), p.y) - r; }
// the grid's cells: the point's offset in its cell (inradius 0.5), and the cell's centre
vec4 hexCell(vec2 p){ vec2 s = vec2(1.0, 1.7320508), h = s * 0.5; vec2 a = mod(p, s) - h, b = mod(p - h, s) - h; vec2 g = dot(a, a) < dot(b, b) ? a : b; return vec4(g, p - g); }
// the way from a to b as a circuit runs: straight along x, then at 45° — how far w is from it, and how far along it
vec2 route(vec2 w, vec2 a, vec2 b){
  vec2 d = b - a; float k = min(abs(d.x), abs(d.y));
  vec2 m = vec2(b.x - sign(d.x) * k, a.y);
  vec2 ab = m - a, mb = b - m;
  float u1 = clamp(dot(w - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0), u2 = clamp(dot(w - m, mb) / max(dot(mb, mb), 1e-9), 0.0, 1.0);
  float d1 = length(w - a - ab * u1), d2 = length(w - m - mb * u2);
  return d1 < d2 ? vec2(d1, u1 * length(ab)) : vec2(d2, length(ab) + u2 * length(mb));
}
// a raised hex platform at q (its top face's inradius r, standing h high): the side faces below its top, a soft shadow
// to the south-east, the top lit from the north-west, a bright rim in its light, an inner ring
vec3 platform(vec3 col, vec2 q, float r, float h, vec3 c, float px, float hot){
  float sh = hexD(q - vec2(h * 0.9, -h * 1.6), r);
  col *= 1.0 - 0.55 * smoothstep(px * 18.0, -px * 2.0, sh);
  float top = hexD(q, r), side = hexD(q + vec2(0.0, h), r);
  float inSide = smoothstep(px, -px, side) * smoothstep(-px, px, top);
  // the sides: dark glass, the west face lit and the east in shade, rows of windows lit in its colour, its own light
  // along the bottom edge
  float west = smoothstep(r * 0.3, -r * 0.3, q.x);
  vec3 sideC = mix(uA * 1.4, c * 0.22, 0.35) * mix(0.75, 1.35, west);
  float row = smoothstep(0.35, 0.0, abs(fract((q.y + h - r) / (px * 4.0)) - 0.5)) * step(0.45, hash(floor(vec2(q.x / (px * 3.0), (q.y + h) / (px * 4.0)))));
  col = mix(col, sideC + c * row * 0.32, inSide);
  col += c * ink(side, px * 1.4) * 0.5 * step(0.0, top);
  float inTop = smoothstep(px, -px, top);
  // the top: glass, a little lighter to the north-west, a sheen across it, a crisp double rim, an inner ring
  vec3 face = mix(uA * 2.2, c * 0.18, 0.5) * (1.0 + 0.25 * clamp(dot(normalize(q + 1e-6), vec2(-0.6, 0.8)), -1.0, 1.0) * smoothstep(0.0, r, length(q)));
  face += vec3(0.75, 0.9, 1.0) * 0.06 * smoothstep(r * 0.5, 0.0, abs(q.x * 0.8 + q.y + r * 0.25)) * smoothstep(0.0, -r * 0.3, top);
  col = mix(col, face, inTop * 0.92);
  col += c * (ink(top, px * 1.2) * (1.1 + 0.8 * hot) + ink(top + px * 3.5, px * 0.6) * 0.35 + exp(-abs(top) / (px * 10.0)) * 0.22 * (1.0 + hot));
  col += c * ink(hexD(q, r * 0.72), px * 0.9) * 0.28 * inTop;
  return col;
}`,
  body: `// a city of light, seen from above
    vec2 w = p * uV.z + uV.xy; float px = max(uP, 0.5) / uR.y * uV.z, spx = max(uP, 0.5) / uR.y;
    // how near the nearest place is, and how built-up the city is here: a district round each place (the core's the
    // largest), a little along the highways, scattered suburbs between
    float near = 9.0, dens = 0.0;
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i]; if (uMarkB[i].w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      float d = length(w - M.xy); near = min(near, d);
      dens += exp(-d / (M.w < 1.5 ? 0.3 : 0.17)) * (M.w < 1.5 ? 1.3 : 0.95);
    }
    float sub = fbm3(w * 1.4 + 7.0);
    dens = clamp(dens + smoothstep(0.05, 0.5, sub) * 0.3, 0.0, 1.6);
    // built-up or not: dense where the city is, in patches at its edges
    float build = smoothstep(0.3, 0.85, dens + 0.35 * fbm3(w * 5.0 + 1.0));
    // the river winding through, dark and smooth; the land a deep blue-black, faintly varied
    float rv = w.y - (0.36 * sin(w.x * 1.15 + 0.4) - 0.12 + 0.09 * fbm3(vec2(w.x * 0.9, 3.0))), river = smoothstep(0.017, 0.009, abs(rv));
    col = uA * (0.85 + 0.25 * fbm3(w * 3.0 + 2.0)) + vec3(0.012, 0.02, 0.035);
    // the city's glow: the light of many streets, too small to see one by one from up here (and all that is left of
    // them when one is far out)
    vec3 sodium = vec3(1.0, 0.6, 0.26), white = vec3(0.9, 0.94, 1.0);
    vec3 cityC = mix(sodium, white, smoothstep(0.7, 1.4, dens) * 0.6);
    col += cityC * (pow(dens, 2.2) * 0.1 + build * 0.025);
    // the streets: a district a cell of a coarse grid, its blocks turned its own way; lamps along them, the crossings
    // brighter; avenues along the districts' edges; nothing on the river
    vec2 wq = w + 0.07 * vec2(fbm3(w * 1.7 + 3.0), fbm3(w * 1.7 + 9.0)); // (the districts' edges bend)
    float dc = 0.42; vec2 dg = wq / dc, cell = floor(dg), inCell = fract(dg);
    float ang = (hash(cell + 11.0) - 0.5) * 1.2, ca = cos(ang), sa = sin(ang);
    float blk = 0.016 * (0.8 + 0.5 * hash(cell + 3.0));
    vec2 g = mat2(ca, sa, -sa, ca) * w / blk, gf = fract(g), gi = floor(g);
    vec2 e = min(gf, 1.0 - gf) * blk; // how far from the block's two edges (world units)
    float fine = smoothstep(3.0, 7.0, blk / px); // streets one can tell apart at this zoom
    float on = step(0.28, hash(gi + cell)) * build; // some blocks dark (parks, water, fields), none out of town
    // each stretch of street its own: lit or not, brighter or dimmer (a city is not a net)
    vec2 sid = vec2(floor(g.x + 0.5), gi.y), tid = vec2(gi.x, floor(g.y + 0.5));
    float sx = step(0.38, hash(sid + cell * 3.1)) * (0.35 + 0.65 * hash(sid + 9.0)), sy = step(0.38, hash(tid + cell * 1.7 + 5.0)) * (0.35 + 0.65 * hash(tid + 2.0));
    float street = max(ink(e.x, px * 0.7) * sx, ink(e.y, px * 0.7) * sy) * on;
    float lamps = street * (0.5 + 0.5 * step(0.55, fract((e.x < e.y ? g.y : g.x) * 3.0)));
    float cross = ink(length(e), px * 1.4) * on * max(sx, sy);
    vec3 lampC = mix(sodium, white, step(0.82, hash(gi + 5.0)) * 0.8 + smoothstep(0.9, 1.4, dens) * 0.3);
    col += lampC * (lamps * 0.45 + cross * 0.9) * (0.35 + 0.8 * dens) * fine * (1.0 - river);
    // the avenues: some of the districts' edges, in town only
    vec2 ed = min(inCell, 1.0 - inCell) * dc;
    float av = ed.x < ed.y ? step(0.4, hash(cell + vec2(1.0, floor(inCell.x + 0.5)))) : step(0.4, hash(cell + vec2(2.0, floor(inCell.y + 0.5))));
    float avenue = ink(min(ed.x, ed.y), px * 1.0) * av * smoothstep(0.45, 1.0, dens);
    col += sodium * avenue * (0.55 + 0.45 * fine) * 0.55 * (1.0 - river);
    // out of town: a light here and there (farms, roads)
    vec2 rc = floor(w / 0.012), rp = fract(w / 0.012) - 0.5;
    col += sodium * step(0.985, hash(rc + 4.0)) * ink(length(rp) * 0.012, px * 0.9) * (1.0 - build) * 0.5 * (1.0 - river);
    // the river: dark water, the city's lights trembling on it near the banks
    col = mix(col, vec3(0.006, 0.012, 0.024) + cityC * dens * 0.03 * (0.6 + 0.4 * sin(w.x * 400.0 + t * 2.0)), river);
    col += cityC * ink(abs(rv) - 0.013, px * 1.0) * dens * 0.12;
    // the conduits from the core to each place: circuit lines, data running outward along them
    vec2 cap = uMark[0].xy;
    for (int i = 1; i < 24; i++) {
      vec4 M = uMark[i]; if (uMarkB[i].w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      vec2 lo = min(cap, M.xy) - px * 14.0, hi = max(cap, M.xy) + px * 14.0;
      if (w.x < lo.x || w.y < lo.y || w.x > hi.x || w.y > hi.y) continue; // (nowhere near this one's way)
      vec2 r = route(w, cap, M.xy); vec3 c = placeCol(M.w);
      float fade = smoothstep(0.05, 0.12, r.y) * smoothstep(0.0, 0.05, length(w - M.xy) - 0.04);
      // a highway: its two lit carriageways, traffic on them — headlights going out, tail lights coming in — and a
      // thin line of the place's own light down the middle (its data)
      float laneD = ink(abs(r.x - px * 2.2), px * 0.8);
      col += vec3(1.0, 0.68, 0.32) * (ink(r.x, px * 3.0) * 0.08 + laneD * 0.12) * fade;
      float outT = step(0.85, fract(r.y / (px * 9.0) - t * 2.2 + hash(vec2(float(i), 1.0)) * 9.0));
      float inT = step(0.85, fract(r.y / (px * 7.0) + t * 1.7 + hash(vec2(float(i), 2.0)) * 9.0));
      col += (vec3(0.95, 0.97, 1.0) * outT + vec3(1.0, 0.25, 0.18) * inT * 0.8) * laneD * 0.9 * fade;
      col += c * ink(r.x, px * 0.8) * 0.2 * fade;
      float pk = fract(r.y * 2.2 - t * 0.35 + float(i) * 0.37);
      col += c * ink(r.x, px * 1.3) * smoothstep(0.86, 0.97, pk) * step(pk, 0.985) * 1.1 * fade;
    }
    // the places: raised platforms, each its own light; the core turning; new tasks a portal; something waiting a beacon.
    // Sized in the page's pixels as the places' pictures and names are (world.jsx placeScale: a little bigger nearer,
    // not as much as the map), so a name stays below its platform at every zoom: \`u\` is one such pixel in the world
    float fitZ = max(3.5 / (uR.x / uR.y), 1.96) * 1.02, u = clamp(pow(fitZ / uV.z, 0.45), 0.75, 1.5) * px;
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i]; vec4 MB = uMarkB[i]; if (MB.w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      vec2 q = w - M.xy; float r = length(q), hot = MB.x; vec3 c = placeCol(M.w);
      if (r > u * 190.0) continue; // (all it draws is nearer than this)
      col += c * exp(-r / (u * 45.0)) * 0.07; // its light on the ground round it
      float R = M.w < 1.5 ? 44.0 * u : abs(M.w - 3.0) < 0.5 ? 0.0 : (31.0 + M.z * 20.0) * u;
      if (R > 0.0) col = platform(col, q, R, R * 0.2, c, px, hot);
      if (M.w < 1.5) {
        // the core: a bright heart, two broken rings turning opposite ways, a third ticking; louder as the agent speaks
        float a = atan(q.y, q.x), e = 1.0 + 0.6 * uK;
        col += c * exp(-r / (u * 30.0)) * 0.35 * e;
        col += c * ink(r - R * 1.25, px * 1.3) * step(0.35, fract((a + t * 0.6) / 6.2832 * 3.0)) * 0.9 * e;
        col += c * ink(r - R * 1.45, px * 1.1) * step(0.5, fract((a - t * 0.35) / 6.2832 * 5.0)) * 0.6;
        col += c * ink(r - R * 1.65, px * 0.9) * step(0.8, fract(a / 6.2832 * 48.0)) * 0.6;
      } else if (abs(M.w - 3.0) < 0.5) {
        // a portal: a ring of light turning, dashes drawn inward, its middle open
        float a = atan(q.y, q.x), P = u * 34.0, sp = fract(a / 6.2832 * 3.0 + log(max(r / P, 1e-3)) * 1.6 + t * 0.4);
        col += c * ink(r - P, px * 1.6) * (0.9 + 0.3 * sin(t * 2.0));
        col += c * ink(r - P * 1.18, px * 1.0) * step(0.6, fract((a + t * 0.5) / 6.2832 * 24.0)) * 0.6;
        col += c * smoothstep(P, P * 0.3, r) * smoothstep(0.75, 0.95, sp) * 0.5;
        col += c * exp(-r / (P * 0.4)) * 0.25;
        R = P;
      } else {
        // a beam of light standing up from its middle (seen from above: a bright point and its glow)
        col += c * exp(-r / (u * 10.0)) * 0.12;
      }
      // the pointer on it: brackets at its corners
      if (hot > 0.5) {
        vec2 b = abs(q) - vec2(R * 1.3 + u * 6.0) - u * 2.0 * sin(t * 4.0);
        float br = min(abs(b.x), abs(b.y)) < px * 1.2 && max(b.x, b.y) < px * 1.2 && min(b.x, b.y) > -u * 12.0 ? 1.0 : 0.0;
        col += c * br * 0.9;
      }
      // something waits there: a beacon sweeping round
      // work done and not looked at (the records): a soft green ring breathing round it
      if (MB.y > 1.5) col += vec3(0.4, 1.0, 0.68) * ink(r - R * (1.45 + 0.05 * sin(t * 1.2)), px * 1.3) * 0.55;
      if (MB.y > 0.5 && MB.y < 1.5) {
        float a = fract(atan(q.y, q.x) / 6.2832 - t * 0.5);
        col += uD * smoothstep(R * 2.6, 0.0, r) * pow(a, 6.0) * 0.45 + uD * ink(r - R * (1.5 + 0.12 * sin(t * 3.0)), px * 1.4) * 0.7;
      }
    }
    // the tasks: a holo-ring each — its steps as arcs (done steady, the one at work bright and running, those to come
    // dim), ticks round it, an inner ring turning, a sweep inside while it works; amber blinking where it waits for the
    // person; a flash of green spreading as it finishes; scheduled ones a dashed ring with a hand going round
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i];
      vec2 q = w - T.xy; float r = length(q), R = T.z, kind = T.w;
      if (r > R * 1.6 + px * 24.0) continue; // (all it draws is nearer than this)
      float hot = abs(float(i) - uN.z) < 0.5 ? 1.0 : 0.0;
      float a = fract(0.25 - atan(q.y, q.x) / 6.2831853), n = max(B.x, 1.0), seg = floor(a * n), within = fract(a * n), gw = min(0.3, 0.02 * n);
      float gap = smoothstep(0.0, gw, within) * smoothstep(1.0, 1.0 - gw, within);
      float ring = ink(r - R, px * 1.4), wide = smoothstep(px * 3.5, px * 1.5, abs(r - R));
      vec3 c = vec3(0.0);
      if (kind > 2.5 && kind < 3.5) {
        c = uB * 0.5 * ring * step(0.5, fract(a * 60.0));
        float hand = fract(t * 0.02 + float(i) * 0.3);
        c += uB * 0.4 * smoothstep(px * 1.5, 0.0, abs(fract(a - hand + 0.5) - 0.5) * 6.2832 * r) * step(r, R * 0.9) * step(R * 0.2, r);
      } else if (kind > 3.5 && kind < 4.5) {
        float age = t - B.w, rr = R * (1.0 + age * 0.12);
        c = vec3(0.4, 1.0, 0.7) * (ink(r - rr, px * 2.0) * 1.5 + exp(-abs(r - rr) / (px * 12.0)) * 0.5) * exp(-age * 1.2);
        c += vec3(0.4, 1.0, 0.7) * ring * 0.5;
      } else {
        bool waits = kind > 1.5 && kind < 2.5, bad = kind > 4.5; // waiting for the person; gone wrong
        vec3 now = bad ? vec3(1.0, 0.3, 0.36) : waits ? uD : vec3(0.85, 0.97, 1.0);
        float blink = waits ? 0.55 + 0.45 * step(0.5, fract(t * 0.9)) : bad ? 0.45 + 0.55 * step(0.35, fract(t * 1.7 + sin(t * 3.1) * 0.3)) : 1.0;
        waits = waits || bad; // (both stand still and blink: nothing runs along)
        float flow = 0.6 + 0.4 * pow(0.5 + 0.5 * sin(within * 20.0 - t * 5.0), 4.0);
        if (seg < B.y) c = uB * wide * 0.85 * gap;
        else if (abs(seg - B.z) < 0.5) c = now * wide * 1.4 * gap * (waits ? blink : flow) + now * exp(-abs(r - R) / (px * 10.0)) * 0.3 * gap;
        else c = uB * ring * 0.25 * step(0.5, fract(a * n * 10.0)) * gap;
        // ticks outside, an inner ring turning (faster while it works), a sweep inside
        c += uB * smoothstep(px * 1.2, 0.0, abs(r - R * 1.12) - px * 3.0 * step(0.92, fract(a * 72.0))) * step(0.88, fract(a * 72.0)) * 0.35;
        float spin = fract(a + t * (waits ? 0.02 : 0.08));
        c += (waits ? uD : uB) * ink(r - R * 0.82, px * 1.0) * step(0.55, fract(spin * 16.0)) * 0.35;
        float sweep = fract(a - t * 0.25);
        if (!waits) c += uB * smoothstep(R * 0.8, R * 0.3, r) * pow(sweep, 8.0) * 0.18;
        if (waits) c += uD * exp(-abs(r - R) / (px * 18.0)) * 0.25 * blink;
      }
      col += c * (1.0 + 0.6 * hot);
    }
    // the messages: a beam from one agent to the other, chevrons running along it, a packet of light at its head
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i], M = uLinkB[i]; if (M.y < 0.5) continue;
      vec2 lo = min(L.xy, L.zw) - px * 12.0, hi = max(L.xy, L.zw) + px * 12.0;
      if (w.x < lo.x || w.y < lo.y || w.x > hi.x || w.y > hi.y) continue;
      vec2 a = L.xy, b = L.zw, ab = b - a; float len = length(ab), len2 = max(dot(ab, ab), 1e-9);
      float u = clamp(dot(w - a, ab) / len2, 0.0, 1.0), d = length(w - a - ab * u), h = fract((t - M.x) * 0.45);
      vec3 c = kindCol(M.z);
      vec2 dir = ab / max(len, 1e-6), nrm = vec2(-dir.y, dir.x);
      float along = dot(w - a, dir), across = dot(w - a, nrm);
      float chev = abs(fract(along / 0.03 - abs(across) / 0.03 - t * 1.5) - 0.5);
      col += c * ink(d, px * 1.0) * 0.35 + c * smoothstep(0.08, 0.0, chev) * step(abs(across), 0.008) * step(0.0, along) * step(along, len) * 0.35;
      col += c * (exp(-length(w - a - ab * h) / (px * 4.0)) * 1.2 + ink(d, px * 2.0) * smoothstep(h - 0.25, h, u) * step(u, h) * 0.8);
    }
    // the agents: drones — a bright diamond each in its colour, a halo, a ring going out when it does something
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i], X = uStarB[i]; vec2 d = w - S.xy; float big = X.x, age = t - S.z; vec3 c = kindCol(S.w);
      if (dot(d, d) > pow(px * 80.0 * big, 2.0)) continue;
      float dm = (abs(d.x) + abs(d.y)) / big, r = length(d);
      float k = 1.0 + (X.y > 0.5 ? 0.4 * sin(t * 3.0) : 0.0) + 0.7 * exp(-age * 2.5);
      col = mix(col, uA, smoothstep(px * 9.0, px * 7.0, dm));
      col += c * (smoothstep(px * 6.0, px * 4.5, dm) * 0.9 + ink(dm - px * 7.5, px * 1.0) * 0.9 + exp(-r / (px * 14.0 * big)) * 0.35) * k;
      col += vec3(1.0) * smoothstep(px * 2.2, px * 1.0, dm) * 0.8;
      if (age < 1.4) col += c * ink(r - px * (12.0 + age * 46.0), px * 1.6) * (1.0 - age / 1.4) * 0.9;
    }
    // the edges darker, faint lines across the screen (a display's)
    col *= 1.0 - 0.38 * dot(p * 0.85, p * 0.85);
    col *= 0.97 + 0.03 * sin(gl_FragCoord.y * 1.4);`,
}
