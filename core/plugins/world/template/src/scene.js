// The blueprint's ground: white lines on blue paper. A fragment shader run for every pixel by the shell's wallpaper
// engine. `p` is the screen point (centred, height 1), `t` the time in seconds; `col` is what it paints. The world is
// what one looks round: `w` below is the world point under this pixel, `px` one page pixel in world units.
// What world.jsx gives each frame (the uniforms below — keep their names):
//   uMark[24] (x, y, how much land, kind number — layout.js KINDS; uMark[0] is the main agent) and uMarkB[24] (the
//     pointer on it, something waits there, —, there at all);
//   uTask[8] (x, y, radius, kind: 1 at work, 2 waiting for the person, 3 scheduled, 4 just done, 5 failed) and uTaskB[8] (steps,
//     steps done, the step at work, — / when it finished);
//   uStar[16] (x, y, when it last did something, which agent: 0 claude, 1 codex, 2 dsh, 3 system, 4 the person) and
//     uStarB[16] (size, waiting); uLink[8] (from x, y, to x, y) and uLinkB[8] (since when, there, whose colour);
//   uN (tasks, agents, the task under the pointer), uV (the view: x, y, the world height a screen shows).
// The shell gives every scene uR (pixels), uT, uK (how lively the main agent is), uP, uA–uD (the four colours `c`), and
// noise: n2, fbm, fbm3, hash, hash22.

export const BLUEPRINT = {
  data: true, fps: 20, tone: 'dark', c: ['#123a6b', '#e8f1ff', '#ffd27a', '#7fb2ff'],
  fn: `
uniform vec4 uTask[8], uTaskB[8], uStar[16], uStarB[16], uLink[8], uLinkB[8], uMark[24], uMarkB[24]; uniform vec3 uN, uV;
float line(float d, float w){ return exp(-pow(d / w, 2.0)); }
float segD(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float u = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0); return length(p - a - ab * u); }`,
  body: `vec2 w = p * uV.z + uV.xy; float px = max(uP, 0.5) / uR.y * uV.z;
    // the paper, a little uneven; a fine grid and a coarser one
    col = uA * (0.92 + 0.1 * fbm3(w * 3.0));
    vec2 g = abs(fract(w / 0.05 + 0.5) - 0.5) * 0.05, G = abs(fract(w / 0.25 + 0.5) - 0.5) * 0.25;
    col = mix(col, uB, line(min(g.x, g.y), px * 0.6) * 0.1 + line(min(G.x, G.y), px * 0.8) * 0.22);
    // lines from the main agent to each place, dashed
    vec2 cap = uMark[0].xy;
    for (int i = 1; i < 24; i++) {
      vec4 M = uMark[i]; if (uMarkB[i].w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      col = mix(col, uB, line(segD(w, cap, M.xy), px * 0.9) * step(0.5, fract(length(w - cap) * 40.0)) * 0.5);
    }
    // the places: a circle each, a second one when the pointer is on it, a cross at its middle
    for (int i = 0; i < 24; i++) {
      vec4 M = uMark[i]; vec4 B = uMarkB[i]; if (B.w < 0.5 || abs(M.w - 14.0) < 0.5) continue;
      float r = length(w - M.xy), R = M.w < 1.5 ? 0.09 : 0.06;
      col = mix(col, uA * 0.85, smoothstep(R, R - px, r) * 0.6);
      col = mix(col, uB, line(r - R, px * 1.1) + line(r - R - 0.012, px * 0.8) * B.x);
      if (B.y > 0.5) col = mix(col, uC, line(r - R - 0.02 - 0.006 * sin(t * 3.0), px * 1.2));
    }
    // the tasks: a ring of their steps — done ones drawn solid, the one at work in yellow, the rest dashed
    for (int i = 0; i < 8; i++) {
      if (float(i) >= uN.x) break;
      vec4 T = uTask[i], B = uTaskB[i]; vec2 q = w - T.xy; float r = length(q);
      float a = fract(0.25 - atan(q.y, q.x) / 6.2831853), n = max(B.x, 1.0), seg = floor(a * n);
      float ring = line(r - T.z, px * 1.2);
      if (T.w > 4.5) col = mix(col, uC, ring * step(0.3, fract(a * 12.0)));
      else if (T.w > 3.5) col = mix(col, uB, ring);
      else if (T.w > 2.5) col = mix(col, uB, ring * step(0.5, fract(a * 60.0)) * 0.6);
      else col = mix(col, seg < B.y ? uB : abs(seg - B.z) < 0.5 ? uC : uB, ring * (seg < B.y || abs(seg - B.z) < 0.5 ? 1.0 : step(0.5, fract(a * n * 8.0)) * 0.6));
    }
    // messages between agents: a dashed line moving along
    for (int i = 0; i < 8; i++) {
      vec4 L = uLink[i]; if (uLinkB[i].y < 0.5) continue;
      col = mix(col, uC, line(segD(w, L.xy, L.zw), px * 1.0) * step(0.5, fract(length(w - L.xy) * 30.0 - t * 2.0)));
    }
    // the agents: a dot each, a ring when it just did something
    for (int i = 0; i < 16; i++) {
      if (float(i) >= uN.y) break;
      vec4 S = uStar[i]; float r = length(w - S.xy), age = t - S.z;
      col = mix(col, uB, smoothstep(px * 5.0, px * 3.5, r));
      if (age < 1.2) col = mix(col, uB, line(r - px * (8.0 + age * 30.0), px * 1.2) * (1.0 - age / 1.2));
    }`,
}
