// Billboards, LED screens and vertical banners (sign styles 3-6, placed by tools/pipeline/signs.mjs).
// The artwork is invented and drawn here, once, into an atlas: neon-sign pictures on Puerto Rican themes — a
// coquí, palms on a beach, a piña colada, a cuatro, a garita of the old city walls, a vejigante mask ... —
// with words in Spanish. No real character, brand or logo is used. A screen cycles through the posters with
// a wipe, seen through an LED grid. Everything glows at night; screens are bright all day.
import * as THREE from 'three';
import { shared } from './materials.js';

const COLS = 8, ROWS = 4, SIZE = 512;
export const WIDE = 24, TALL = 8; // posters 0..23 fill their cell; 24..31 are banners in the left third of theirs
const FONT = '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const SHORT = ['SOL', 'RON', 'ISLA', 'PLAYA', 'CAFÉ', 'SALSA', 'BOMBA', 'PLENA', 'VIVA', 'WEPA', 'PIÑA', 'AMOR', 'BAILE'];
const LONG = ['OFERTA', 'MOFONGO', 'FIESTA', 'BORINQUEN', 'COQUÍ', 'BORICUA', 'LECHÓN', 'MÚSICA', 'TIENDA', 'CASINO', 'EN VIVO', 'ESPECIAL'];
// neon tubes: pink, turquoise, yellow, green, orange, violet, red, white
const NEON = ['#ff3d9a', '#22e6d4', '#ffe23d', '#4dff88', '#ff8a2b', '#b56bff', '#ff3838', '#f4f8ff'];
const NIGHT = ['#0b0620', '#06142b', '#1a0626', '#04181a', '#200a0a', '#0a0a18'];

// ---- the pictures: each draws in a box about 1 wide and 1 high centred on the origin, as glowing tubes
const tube = (g, colour, width = 0.05) => { g.strokeStyle = colour; g.fillStyle = colour; g.shadowColor = colour; g.shadowBlur = 26; g.lineWidth = width; g.lineCap = 'round'; g.lineJoin = 'round'; };
const line = (g, pts, close = false) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); g.stroke(); };
const ring = (g, x, y, r, fill = false) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); if (fill) g.fill(); else g.stroke(); };
// a palm: a curved trunk from (x, y) up to its crown, fronds drooping all round
const palm = (g, x, y, h, lean, a, b) => {
  tube(g, a, 0.045);
  const tx = x + lean, ty = y - h;
  g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + lean * 0.2, y - h * 0.6, tx, ty); g.stroke();
  tube(g, b, 0.04);
  for (let k = 0; k < 6; k++) {
    const t = (k / 5) * Math.PI, dx = -Math.cos(t), dy = -Math.sin(t) * 0.5;
    g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + dx * 0.16, ty + dy * 0.2 - 0.06, tx + dx * 0.26, ty + dy * 0.1 + 0.08); g.stroke();
  }
};
const PICTURES = [
  function coqui(g, a, b) { // the coquí: a little tree frog, big eyes, toe pads spread
    tube(g, a); g.beginPath(); g.ellipse(0, 0.06, 0.22, 0.16, 0, 0, Math.PI * 2); g.stroke();
    ring(g, -0.12, -0.12, 0.08); ring(g, 0.12, -0.12, 0.08);
    tube(g, b, 0.035); ring(g, -0.12, -0.12, 0.03, true); ring(g, 0.12, -0.12, 0.03, true);
    tube(g, a, 0.04);
    for (const s of [-1, 1]) { line(g, [[s * 0.18, 0.12], [s * 0.34, 0.22], [s * 0.42, 0.12]]); line(g, [[s * 0.16, -0.02], [s * 0.32, -0.06], [s * 0.38, -0.18]]); }
    tube(g, b, 0.03); for (const s of [-1, 1]) { ring(g, s * 0.42, 0.12, 0.025, true); ring(g, s * 0.38, -0.18, 0.025, true); }
    line(g, [[-0.07, 0.04], [0, 0.07], [0.07, 0.04]]);
  },
  function beach(g, a, b) { // palms on a beach under the sun
    tube(g, '#ffe23d'); ring(g, 0.24, -0.22, 0.12, true);
    palm(g, -0.2, 0.32, 0.56, 0.12, a, b); palm(g, 0.02, 0.32, 0.4, 0.14, a, b);
    tube(g, '#22e6d4', 0.035); line(g, [[-0.48, 0.38], [-0.3, 0.33], [-0.12, 0.38], [0.06, 0.33], [0.24, 0.38], [0.48, 0.33]]);
  },
  function sunset(g, a, b) { // the sun going down into the sea
    tube(g, a); g.beginPath(); g.arc(0, 0.1, 0.26, Math.PI, Math.PI * 2); g.stroke();
    tube(g, b, 0.035); for (let k = 0; k < 7; k++) { const t = Math.PI + ((k + 0.5) / 7) * Math.PI; line(g, [[Math.cos(t) * 0.33, 0.1 + Math.sin(t) * 0.33], [Math.cos(t) * 0.44, 0.1 + Math.sin(t) * 0.44]]); }
    tube(g, '#22e6d4', 0.035); for (const [y, w] of [[0.16, 0.46], [0.26, 0.34], [0.36, 0.22]]) line(g, [[-w, y], [w, y]]);
  },
  function wave(g, a, b) { // a curling wave, for the surf
    tube(g, a); for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(-0.2 + k * 0.22, 0.1 + k * 0.08, 0.26 - k * 0.04, Math.PI * 0.9, Math.PI * 2.1); g.stroke(); }
    tube(g, b, 0.04); for (let k = 0; k < 5; k++) ring(g, -0.42 + k * 0.05, -0.12 - k * 0.03, 0.02, true);
    line(g, [[-0.48, 0.38], [-0.24, 0.3], [0, 0.38], [0.24, 0.3], [0.48, 0.38]]);
  },
  function car(g, a, b) { // a new car, for the dealers
    tube(g, a); line(g, [[-0.46, 0.12], [-0.4, 0], [-0.16, -0.04], [0, -0.18], [0.24, -0.18], [0.36, -0.02], [0.47, 0.02], [0.47, 0.12], [-0.46, 0.12]]);
    line(g, [[-0.1, -0.03], [0.02, -0.13], [0.2, -0.13], [0.28, -0.03]], true);
    tube(g, b); for (const x of [-0.26, 0.28]) ring(g, x, 0.14, 0.09);
    tube(g, '#f4f8ff', 0.03); for (let k = 0; k < 3; k++) line(g, [[-0.5 - k * 0.04, -0.14 + k * 0.1], [-0.3 - k * 0.06, -0.14 + k * 0.1]]);
  },
  function colada(g, a, b) { // a piña colada with its umbrella and a wedge of pineapple
    tube(g, a); line(g, [[-0.2, -0.2], [0.2, -0.2], [0.08, 0.06], [0.03, 0.06], [0.03, 0.32], [-0.03, 0.32], [-0.03, 0.06], [-0.08, 0.06]], true); line(g, [[-0.16, 0.34], [0.16, 0.34]]);
    tube(g, b, 0.035); g.beginPath(); g.arc(-0.14, -0.3, 0.16, Math.PI * 1.05, Math.PI * 1.95); g.closePath(); g.stroke(); line(g, [[-0.14, -0.3], [-0.06, -0.12]]);
    tube(g, '#ffe23d', 0.035); g.beginPath(); g.arc(0.22, -0.22, 0.09, Math.PI * 0.6, Math.PI * 1.9); g.stroke();
  },
  function coffee(g, a, b) { // a steaming cup of Puerto Rican coffee
    tube(g, a); line(g, [[-0.26, -0.06], [0.2, -0.06], [0.16, 0.26], [-0.22, 0.26]], true);
    g.beginPath(); g.arc(0.24, 0.06, 0.1, -Math.PI / 2, Math.PI / 2); g.stroke(); line(g, [[-0.36, 0.34], [0.32, 0.34]]);
    tube(g, b, 0.03); for (const x of [-0.14, 0, 0.12]) { g.beginPath(); g.moveTo(x, -0.12); g.bezierCurveTo(x + 0.08, -0.2, x - 0.08, -0.28, x, -0.4); g.stroke(); }
  },
  function cuatro(g, a, b) { // the cuatro, the island's ten-string guitar
    tube(g, a); g.beginPath(); g.ellipse(-0.18, 0.12, 0.2, 0.16, -0.5, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.ellipse(0, -0.02, 0.13, 0.11, -0.5, 0, Math.PI * 2); g.stroke();
    line(g, [[0.08, -0.08], [0.4, -0.3]]); line(g, [[0.38, -0.34], [0.48, -0.4], [0.44, -0.26]], true);
    tube(g, b, 0.03); ring(g, -0.12, 0.08, 0.05); for (let k = 0; k < 3; k++) line(g, [[-0.28, 0.16 + k * 0.025], [0.4, -0.31 + k * 0.025]]);
  },
  function pineapple(g, a, b) { // a pineapple
    tube(g, a); g.beginPath(); g.ellipse(0, 0.14, 0.2, 0.26, 0, 0, Math.PI * 2); g.stroke();
    tube(g, a, 0.03); for (let k = -2; k <= 2; k++) { line(g, [[k * 0.09 - 0.12, -0.06], [k * 0.09 + 0.12, 0.34]]); line(g, [[k * 0.09 + 0.12, -0.06], [k * 0.09 - 0.12, 0.34]]); }
    tube(g, b, 0.045); for (const [dx, h] of [[-0.14, 0.18], [-0.06, 0.26], [0, 0.32], [0.06, 0.26], [0.14, 0.18]]) line(g, [[0, -0.12], [dx, -0.12 - h]]);
  },
  function garita(g, a, b) { // a garita, the domed sentry box of the old city walls
    tube(g, a); line(g, [[-0.16, 0.18], [-0.16, -0.12], [0.16, -0.12], [0.16, 0.18]]); g.beginPath(); g.arc(0, -0.12, 0.16, Math.PI, Math.PI * 2); g.stroke();
    line(g, [[0, -0.28], [0, -0.38]]); ring(g, 0, -0.4, 0.025, true);
    line(g, [[-0.22, 0.18], [0.22, 0.18], [0.12, 0.3], [-0.12, 0.3]], true);
    tube(g, b, 0.035); line(g, [[-0.05, 0.1], [-0.05, -0.04], [0.05, -0.04], [0.05, 0.1]]); line(g, [[-0.48, 0.3], [-0.22, 0.24]]); line(g, [[0.22, 0.24], [0.48, 0.3]]);
  },
  function flor(g, a, b) { // a hibiscus flower
    tube(g, a, 0.04);
    for (let k = 0; k < 5; k++) { const t = (k * Math.PI * 2) / 5 - Math.PI / 2; g.beginPath(); g.ellipse(Math.cos(t) * 0.17, Math.sin(t) * 0.17, 0.17, 0.12, t, 0, Math.PI * 2); g.stroke(); }
    tube(g, b, 0.03); line(g, [[0, 0], [0.18, -0.26]]); for (let k = 0; k < 4; k++) ring(g, 0.18 + (k - 1.5) * 0.03, -0.28 - (k % 2) * 0.03, 0.018, true);
  },
  function vejigante(g, a, b) { // a vejigante carnival mask, horned
    tube(g, a); g.beginPath(); g.ellipse(0, 0.08, 0.24, 0.28, 0, 0, Math.PI * 2); g.stroke();
    for (const [x, y, ex, ey] of [[-0.18, -0.12, -0.4, -0.4], [-0.06, -0.18, -0.12, -0.46], [0.06, -0.18, 0.12, -0.46], [0.18, -0.12, 0.4, -0.4]]) line(g, [[x - 0.04, y], [ex, ey], [x + 0.04, y]]);
    tube(g, b, 0.04); for (const s of [-1, 1]) ring(g, s * 0.09, 0.02, 0.05, true);
    line(g, [[-0.12, 0.2], [-0.06, 0.24], [0, 0.2], [0.06, 0.24], [0.12, 0.2]]);
  },
];

function atlas() {
  const c = document.createElement('canvas');
  c.width = COLS * SIZE; c.height = ROWS * SIZE;
  const g = c.getContext('2d');
  let seed = 11;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const S = SIZE;
  const cell = (i, draw) => {
    g.save();
    g.translate((i % COLS) * S, Math.floor(i / COLS) * S);
    g.beginPath(); g.rect(0, 0, S, S); g.clip();
    draw();
    g.restore();
  };
  const backdrop = (w) => {
    const grad = g.createLinearGradient(0, 0, w, S);
    grad.addColorStop(0, pick(NIGHT)); grad.addColorStop(1, pick(NIGHT));
    g.shadowBlur = 0; g.fillStyle = grad; g.fillRect(0, 0, w, S);
  };
  const words = (text, x, y, size, colour, vertical) => {
    g.font = `900 ${size}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = colour; g.shadowBlur = 30; g.fillStyle = '#ffffff'; g.strokeStyle = colour; g.lineWidth = size * 0.09;
    const chars = vertical ? [...text] : [text];
    chars.forEach((ch, k) => { const yy = y + (k - (chars.length - 1) / 2) * size * 1.06; g.strokeText(ch, x, yy); g.fillText(ch, x, yy); });
  };
  // ---- wide posters: a picture on one side, words on the other, a tube round the edge
  for (let i = 0; i < WIDE; i++) cell(i, () => {
    const a = NEON[i % NEON.length], b = NEON[(i * 3 + 2) % NEON.length], w = NEON[(i * 5 + 4) % NEON.length], left = i % 2 === 0;
    backdrop(S);
    g.lineWidth = 10; g.strokeStyle = w; g.shadowColor = w; g.shadowBlur = 24; g.strokeRect(22, 22, S - 44, S - 44);
    g.save(); g.translate(S * (left ? 0.32 : 0.68), S * 0.5); g.scale(S * 0.5, S * 0.74); PICTURES[i % PICTURES.length](g, a, b); g.restore();
    // a short word stacked letter over letter, or a long one turned on its side
    if (i % 3 !== 2) { const t = pick(SHORT), size = Math.min(S * 0.19, (S * 0.8) / [...t].length); words(t, S * (left ? 0.78 : 0.22), S * 0.5, size, w, true); }
    else { const t = pick(LONG); g.save(); g.translate(S * (left ? 0.74 : 0.26), S * 0.5); g.rotate(-Math.PI / 2); words(t, 0, 0, Math.min(S * 0.16, (S * 0.8) / (t.length * 0.62)), w, false); g.restore(); }
  });
  // ---- banners, for the sides of buildings: one column of big characters over a small picture, in the left third
  for (let i = 0; i < TALL; i++) cell(WIDE + i, () => {
    const a = NEON[(i * 3) % NEON.length], b = NEON[(i * 3 + 5) % NEON.length], W = S / 3;
    backdrop(W);
    g.lineWidth = 8; g.strokeStyle = a; g.shadowColor = a; g.shadowBlur = 22; g.strokeRect(12, 12, W - 24, S - 24);
    const t = pick(SHORT), n = [...t].length;
    words(t, W / 2, S * 0.4, Math.min(W * 0.62, (S * 0.62) / n), a, true);
    g.save(); g.translate(W / 2, S * 0.84); g.scale(W * 0.7, S * 0.2); PICTURES[(i * 5 + 1) % PICTURES.length](g, b, a); g.restore();
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export class Ads {
  constructor() {
    // uv: position within the board (0-1); aAd: x poster index, y 0 board / 1 screen / 2 banner, z seed
    this.material = new THREE.MeshStandardMaterial({ map: atlas(), roughness: 0.5 });
    this.material.onBeforeCompile = (shader) => {
    shader.uniforms.uLampOn = { value: 0 }; shader.uniforms.uLampMap = shared.uLampMap; // (no lamp light here; the sampler still needs its texture)
      shader.uniforms.uNight = shared.uNight;
      shader.uniforms.uTime = shared.uTime;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec3 aAd;\nvarying vec3 vAd;\nvarying vec2 vBoard;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAd = aAd;\nvBoard = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>
          uniform float uNight, uTime;
          varying vec3 vAd;
          varying vec2 vBoard;
          vec3 gAd;
          vec3 poster(float index, vec2 at) {
            float i = floor(index + 0.5); // the index is interpolated: round it
            vec2 cell = vec2(mod(i, ${COLS}.0), ${ROWS - 1}.0 - floor(i / ${COLS}.0));
            return texture2D(map, (cell + clamp(at, 0.004, 0.996)) / vec2(${COLS}.0, ${ROWS}.0)).rgb;
          }`)
        .replace('#include <map_fragment>', `
          if (vAd.y > 1.5) gAd = poster(vAd.x, vec2(vBoard.x / 3.0, vBoard.y));      // a banner: the left third of its cell
          else if (vAd.y > 0.5) {
            // a screen: the next poster wipes in every few seconds; LED pixels show close up
            float t = uTime * 0.16 + vAd.z * 9.0, wipe = smoothstep(0.86, 1.0, fract(t));
            float now = mod(vAd.x + floor(t), ${WIDE}.0), next = mod(now + 1.0, ${WIDE}.0);
            gAd = mix(poster(now, vBoard), poster(next, vBoard), step(vBoard.x, wipe));
            vec2 led = fract(vBoard * vec2(160.0, 90.0));
            float fine = max(fwidth(vBoard.x * 160.0), fwidth(vBoard.y * 90.0));
            gAd *= mix(0.72 + 0.5 * step(0.22, led.x) * step(0.22, led.y), 1.0, smoothstep(0.3, 1.0, fine));
          } else gAd = poster(vAd.x, vBoard);
          // by day an unlit neon sign is dull glass on a dark board: only its colour shows
          diffuseColor.rgb *= mix(gAd * 0.55 + 0.03, gAd, uNight);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += gAd * (vAd.y > 0.5 && vAd.y < 1.5 ? 1.0 + 0.9 * uNight : 0.1 + 2.2 * uNight);`);
    };
    this.material.customProgramCacheKey = () => 'ads-v2';
    this.frame = new THREE.MeshStandardMaterial({ color: 0x2a2c2f, roughness: 0.6, metalness: 0.4, side: THREE.DoubleSide });
  }

  // ads: signs of style 3 (billboard on a wall), 4 (screen on a wall), 5 (billboard on a frame on the roof),
  // 6 (vertical banner on a wall).
  build(ads) {
    const pos = [], uv = [], ad = [], frame = [];
    for (const s of ads) {
      const rx = s.nz, rz = -s.nx, out = 0.3; // reader's right; boards stand a little off the wall
      const P = (side, up, off = out) => [s.x + rx * side * s.w / 2 + s.nx * off, s.y + (up - 0.5) * s.h, s.z + rz * side * s.w / 2 + s.nz * off];
      const corners = [P(-1, 0), P(1, 0), P(1, 1), P(-1, 0), P(1, 1), P(-1, 1)];
      for (const c of corners) pos.push(...c);
      uv.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
      const seed = (Math.abs(s.x * 0.37 + s.z * 0.91) % 1);
      for (let i = 0; i < 6; i++) ad.push(s.color, s.style === 4 ? 1 : s.style === 6 ? 2 : 0, seed);
      // a dark casing behind the board, and legs under a rooftop one
      const back = [P(-1.03, -0.03, out - 0.08), P(1.03, -0.03, out - 0.08), P(1.03, 1.03, out - 0.08), P(-1.03, 1.03, out - 0.08)];
      frame.push(...back[0], ...back[1], ...back[2], ...back[0], ...back[2], ...back[3]);
      if (s.style === 5) for (const side of [-0.8, 0, 0.8]) {
        const a = P(side - 0.03, 0, out - 0.1), b = P(side + 0.03, 0, out - 0.1), legs = 1.6;
        frame.push(a[0], a[1] - legs, a[2], b[0], b[1] - legs, b[2], ...b, a[0], a[1] - legs, a[2], ...b, ...a);
      }
    }
    const group = new THREE.Group();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setAttribute('aAd', new THREE.Float32BufferAttribute(ad, 3));
    geo.computeVertexNormals();
    const fgeo = new THREE.BufferGeometry();
    fgeo.setAttribute('position', new THREE.Float32BufferAttribute(frame, 3));
    fgeo.computeVertexNormals();
    group.add(new THREE.Mesh(fgeo, this.frame), new THREE.Mesh(geo, this.material));
    return group;
  }
}
