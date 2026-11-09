// A camera move through the city, rendered frame by frame to PNGs, each with an exact depth pass and a normal pass
// beside it: the references a depth- or normal-conditioned video-to-video model needs to keep San Juan's buildings
// where they are while it repaints them (or plates to composite over). The client is driven in headless Chrome and stepped by hand
// (window.__app.frame(dt)), so every frame is 1/fps of city time after the last however long it took to draw, and
// none is taken before the tiles in view are in. Both passes come from the renderer's own depth buffer (the
// composer's stable depth texture), so they match the picture pixel for pixel, sea and terrain and cars included.
//
//   npm run dev                                       # the client, on :5280
//   node tools/render/flythrough.mjs --shot=morro     # -> data/renders/morro/{color,depth,normal}/0001.png …, and an .mp4 of each, compare.mp4
//
//   --stills=1        only the first, middle and last frames (to frame a shot before rendering all of it)
//   --radius=<m>      how far round the point looked at the city is loaded in full (beyond it: blocks), instead of the shot's
//   --people=<n>      the crowd's density (0: nobody), instead of the shot's
//   --min-free=10     stop if the machine's free memory falls below this many percent
//   --fps=24 --size=1280x720 --url=http://localhost:5280 --port=9333 --chrome=<path to Chrome>
//
// Memory, on an 8 GB Mac. The page alone takes some 3 GB. A close shot's `radius` keeps only what it sees up close in
// full (at quality=high it is 1.4 km round the point looked at). The crowd is the danger: low over Old San Juan, where
// hundreds of people are in view, drawing them (world/people.js, one BatchedMesh) made Chrome's GPU layer (ANGLE on
// Metal) take some 2 MB of wired memory per person drawn, gigabytes within three frames, with or without multi-draw
// and whatever the attributes' formats; the frames came out black and the machine stalled. Such a shot sets
// `people: 0` (from 50 m up they are a few pixels, and an image model paints its own). The render stops if free
// memory falls below --min-free, or if the GPU context is lost or a shader fails; the low point is printed at the end.
//
// Depth is drawn white near, black far (and black for the sky), on a log scale between the shot's dNear and dFar,
// fixed for the whole shot so that it does not flicker: the convention of depth ControlNets. From the air it is
// nearly flat (a 15 m building 1 km off is less than one grey level), so the normal pass carries the buildings'
// shapes: camera-space normals (x right = red, y up = green, towards the camera = blue), reconstructed from the
// depth of each pixel's neighbours, black for the sky. A shot's `near` pulls the camera's near plane out for its
// frames (nothing comes closer from the air), which makes the depth buffer, and so the normals, far finer.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

// Shots: the camera's eye and the point it looks at, each from [start] to [end] (x east, y above the ground there,
// z south: metres from Plaza de Armas), eased in and out like the opening's (experience.js); the hour on San
// Juan's clock (held still), clouds as a coverage (0: none); radius: metres of city loaded in full, people: the
// crowd's density (see Memory).
const SHOTS = {
  // Old San Juan from over the Atlantic: El Morro on its headland, the old city behind it, Puerta de Tierra and the
  // Condado towers beyond, late in the afternoon (the sun low in the west-southwest, behind the camera's right)
  morro: {
    hour: 16.6, dur: 8, clouds: 0.3, near: 100, dNear: 350, dFar: 20000,
    eye: [[-1400, 290, -1260], [-1150, 230, -1030]], at: [[-250, 0, -150], [80, 0, -180]],
  },
  // El Morro close, from low over the harbour mouth: an arc from west-northwest to north-northwest round its point,
  // the batteries over the water rising in terraces to the landward bastions and the lighthouse
  morroLow: {
    hour: 16.6, dur: 8, clouds: 0.3, near: 30, dNear: 150, dFar: 8000, radius: 800,
    eye: [[-1050, 35, -690], [-960, 35, -830]], at: [[-805, 8, -615], [-795, 8, -625]],
  },
  // San Juan Bautista: in from the west-southwest over the roofs of the old city towards its front on Calle del
  // Cristo (it faces west, lit by the afternoon sun), its bell gable and the dome over the crossing. Nobody on foot:
  // the old city's crowd is more than the GPU can hold (see Memory)
  cathedral: {
    hour: 16.6, dur: 8, clouds: 0.3, near: 25, dNear: 80, dFar: 5000, radius: 500, people: 0,
    eye: [[-290, 50, 15], [-245, 45, -25]], at: [[-128, 16, -46], [-125, 16, -48]],
  },
  // The Capitol from the south, over Avenida Ponce de León: a slow arc from the southwest to its front, the rotunda
  // against the Atlantic
  capitolio: {
    hour: 16.4, dur: 8, clouds: 0.3, near: 25, dNear: 120, dFar: 6000, radius: 600,
    eye: [[1010, 55, -10], [1120, 50, -30]], at: [[1122, 20, -164], [1125, 20, -164]],
  },
};

const shot = SHOTS[args.shot ?? 'morro'];
if (!shot) { console.error(`no shot "${args.shot}"; shots: ${Object.keys(SHOTS).join(', ')}`); process.exit(1); }
const name = args.shot ?? 'morro';
const FPS = Number(args.fps ?? 24), [W, H] = (args.size ?? '1280x720').split('x').map(Number);
const URL0 = args.url ?? 'http://localhost:5280', PORT = Number(args.port ?? 9333);
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.resolve(ROOT, args.out ?? `data/renders/${name}`);
const stills = args.stills === '1';

// the page's view at the start of the shot, as ?cam=x,z,distance,azimuth,elevation (main.js), so that the first
// tiles loaded are the ones the shot opens on
const [e0, a0] = [shot.eye[0], shot.at[0]];
const dx = e0[0] - a0[0], dy = e0[1] - a0[1], dz = e0[2] - a0[2], r = Math.hypot(dx, dy, dz);
const deg = (v) => (v * 180) / Math.PI;
const cam = [a0[0], a0[2], r, deg(Math.atan2(dx, dz)), deg(Math.asin(dy / r))].map((v) => v.toFixed(1)).join(',');
const radius = Number(args.radius ?? shot.radius ?? 0), people = args.people ?? shot.people;
const page = `${URL0}/?area=sanjuan&sim=0&quality=high&time=${shot.hour}&clouds=${shot.clouds ?? 0}&cam=${cam}`
  + `${radius ? `&radius=${radius}` : ''}${people != null ? `&people=${people}` : ''}`;

// ---------------------------------------------------------------- Chrome, over the DevTools protocol
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'flythrough-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--use-angle=metal', `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
], { stdio: 'ignore' });
const exited = new Promise((r) => chrome.once('exit', r));
// (Memory: twice a second, the machine's free memory as macOS reckons it, a percentage, and its wired memory, where
// the GPU's allocations go: Chrome's own resident size says little, its pages being compressed as memory runs out.
// Below --min-free, Chrome is stopped at once.)
const MIN_FREE = Number(args['min-free'] ?? 10), mem = { low: 100, wired: 0, starved: false };
const sampler = setInterval(() => {
  try {
    const free = Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_level']).stdout) || 100;
    const wired = Number(spawnSync('vm_stat').stdout.toString().match(/Pages wired down:\s+(\d+)/)?.[1] ?? 0) * 16384 / 2 ** 30;
    Object.assign(mem, { low: Math.min(mem.low, free), wired: Math.max(mem.wired, wired) });
    if (free < MIN_FREE && !mem.starved) { mem.starved = true; console.error(`free memory down to ${free}%: stopping Chrome before the machine stalls`); chrome.kill('SIGKILL'); }
  } catch { /* (a sample missed) */ }
}, 500);
const quit = async () => {
  clearInterval(sampler);
  try { chrome.kill(); } catch { /* gone */ }
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); // (it writes to its profile as it closes)
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
};
process.on('SIGINT', () => { quit().finally(() => process.exit(130)); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null);
}
if (!target) { await quit(); throw new Error('Chrome did not start'); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const waiting = new Map(), errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && waiting.has(d.id)) { const { res, rej } = waiting.get(d.id); waiting.delete(d.id); if (d.error) rej(new Error(d.error.message)); else res(d.result); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push(d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') errors.push(`${d.params.entry.text}${d.params.entry.url ? ` (${d.params.entry.url})` : ''}`);
};
// (Chrome gone, stopped for memory or crashed: whatever was asked of it fails rather than waits for ever)
ws.onclose = () => { for (const { rej } of waiting.values()) rej(new Error(mem.starved ? `stopped: free memory fell below ${MIN_FREE}% (see Memory at the top)` : 'Chrome closed')); waiting.clear(); };
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

// ---------------------------------------------------------------- in the page
// (sent as source: it runs in the page, with the app's own three.js, imported by the URL vite served it from so
// that it is the same module and not a second copy)
const setup = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok, what, ms = 180000) => { const t0 = performance.now(); while (!ok()) { if (performance.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(100); } };
  await until(() => window.__app, 'the app');
  const A = window.__app;
  await until(() => document.getElementById('loader')?.classList.contains('done') && A.atmosphere.ready, 'the city to load');
  window.requestAnimationFrame = () => 0; // (the page's own loop stops at its next frame: from here on frames are stepped)
  await sleep(250);
  const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\\/\\.vite\\/deps\\/three\\.js(\\?|$)/.test(n));
  if (!url) throw new Error('three.js not found among the loaded modules');
  const T = await import(url);
  A.atmosphere.quality = 'high';
  A.atmosphere.grain.blendMode.opacity.value = 0; // (a clean plate: grain reads as texture to an image model)
  const shot = ${JSON.stringify(shot)};
  const lerp = (a, b, t) => a + (b - a) * t, ease = (t) => t * t * (3 - 2 * t);
  const place = (f) => {
    const e = ease(Math.min(1, Math.max(0, f))), g = (x, z) => A.streamer.ground(x, z);
    const p = (k) => [0, 1, 2].map((i) => lerp(shot[k][0][i], shot[k][1][i], e));
    const [ex, ey, ez] = p('eye'), [ax, ay, az] = p('at');
    A.camera.position.set(ex, g(ex, ez) + ey, ez);
    A.controls.target.set(ax, g(ax, az) + ay, az);
    A.camera.lookAt(A.controls.target);
  };
  if (shot.near) { A.camera.near = shot.near; A.camera.updateProjectionMatrix(); }
  const canvas = A.renderer.domElement;
  let lost = false; canvas.addEventListener('webglcontextlost', () => { lost = true; });
  // one material, two passes: mode 0 the depth, mode 1 the normals
  const mat = new T.ShaderMaterial({
    uniforms: {
      tDepth: { value: null }, mode: { value: 0 }, near: { value: A.camera.near }, far: { value: A.camera.far },
      dNear: { value: shot.dNear }, dFar: { value: shot.dFar }, projInv: { value: A.camera.projectionMatrixInverse },
      camWorld: { value: A.camera.matrixWorld }, worldCam: { value: A.camera.matrixWorldInverse },
      // (the sea: the tiles' water is drawn with the road surfaces' polygon offset, which brings its depth about a
      // pixel's change in depth nearer, so it reads a metre or so above the sea at 600 m, and a seam between two
      // tiles, where the plain below shows, becomes a step the normals would draw as a line on the open sea: whatever
      // reads within that much of sea level is level)
      sea: { value: (A.scene.getObjectByName('plain')?.position.y ?? -0.15) + 0.15 },
      texel: { value: new T.Vector2(1 / canvas.width, 1 / canvas.height) },
    },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: \`#include <packing>
      uniform sampler2D tDepth; uniform int mode; uniform float near, far, dNear, dFar, sea; uniform mat4 projInv, camWorld, worldCam; uniform vec2 texel;
      varying vec2 vUv;
      vec3 at(vec2 uv) { // the camera-space position seen at uv
        vec4 v = projInv * vec4(uv * 2.0 - 1.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0);
        return v.xyz / v.w;
      }
      void main() {
        float d = texture2D(tDepth, vUv).x;
        if (d >= 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
        if (mode == 0) {
          float z = -perspectiveDepthToViewZ(d, near, far);
          gl_FragColor = vec4(vec3(1.0 - clamp(log(z / dNear) / log(dFar / dNear), 0.0, 1.0)), 1.0);
          return;
        }
        // (across each axis, the neighbour nearer in depth: an edge does not bend the normal of the face it bounds)
        vec3 p = at(vUv);
        if ((camWorld * vec4(p, 1.0)).y < sea + min(0.5 + 0.004 * length(p), 6.0)) { gl_FragColor = vec4(normalize((worldCam * vec4(0.0, 1.0, 0.0, 0.0)).xyz) * 0.5 + 0.5, 1.0); return; }
        vec3 l = at(vUv - vec2(texel.x, 0.0)), r = at(vUv + vec2(texel.x, 0.0));
        vec3 b = at(vUv - vec2(0.0, texel.y)), t = at(vUv + vec2(0.0, texel.y));
        vec3 dx = abs(r.z - p.z) < abs(p.z - l.z) ? r - p : p - l;
        vec3 dy = abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b;
        gl_FragColor = vec4(normalize(cross(dx, dy)) * 0.5 + 0.5, 1.0);
      }\`,
    depthTest: false, depthWrite: false,
  });
  const quad = new T.Mesh(new T.PlaneGeometry(2, 2), mat); quad.frustumCulled = false;
  const qs = new T.Scene(); qs.add(quad);
  const qc = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const pass = (mode) => { mat.uniforms.mode.value = mode; A.renderer.setRenderTarget(null); A.renderer.render(qs, qc); return canvas.toDataURL('image/png'); };
  window.__fly = {
    // the camera at f (0..1 through the shot), every tile in view loaded, then one frame of dt: the picture, its depth, its normals
    async step(f, dt, settle = 0) {
      if (lost) throw new Error('the WebGL context was lost');
      let waited = 0;
      for (let k = 0; k < 900; k++) {
        place(f); A.frame(0);
        if (!A.streamer.pending && k >= settle) break;
        waited++; await sleep(20);
      }
      place(f); A.frame(dt);
      const color = canvas.toDataURL('image/png');
      const depth = A.atmosphere.composer.stableDepthTexture;
      if (!depth) throw new Error('the composer has no depth texture');
      mat.uniforms.tDepth.value = depth;
      return { color, depth: pass(0), normal: pass(1), waited };
    },
    warm(f, n, dt) { for (let i = 0; i < n; i++) { place(f); A.frame(dt); } },
  };
  return { w: canvas.width, h: canvas.height, three: T.REVISION };
})()`;

try {
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  console.log(`loading ${page}`);
  await send('Page.navigate', { url: page });
  const t0 = Date.now();
  const info = await evaluate(setup);
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(0)} s: canvas ${info.w}x${info.h}, three r${info.three}`);
  if (info.w !== W || info.h !== H) console.warn(`(the canvas is ${info.w}x${info.h}, not ${W}x${H})`);

  const n = Math.round(shot.dur * FPS), dt = 1 / FPS;
  const frames = stills ? [0, Math.floor((n - 1) / 2), n - 1] : [...Array(n).keys()];
  const dir = stills ? path.join(OUT, 'stills') : OUT;
  for (const sub of ['color', 'depth', 'normal']) { fs.rmSync(path.join(dir, sub), { recursive: true, force: true }); fs.mkdirSync(path.join(dir, sub), { recursive: true }); }
  // the city settles at the opening pose first: the clouds' and the occlusion's history fills, the traffic spreads out
  await evaluate(`window.__fly.step(0, 0, 10).then(() => window.__fly.warm(0, ${Math.round(FPS * 1.5)}, ${dt}))`);
  const t1 = Date.now();
  for (const [j, i] of frames.entries()) {
    const f = n > 1 ? i / (n - 1) : 0;
    const r = await evaluate(`window.__fly.step(${f}, ${dt}, ${j === 0 ? 4 : 0})`);
    // (a shader the GPU would not take, or a lost context: black frames from here on, most likely memory run out)
    const gpu = errors.find((e) => /Shader Error|CONTEXT_LOST|context was lost/i.test(e));
    if (gpu) throw new Error(`the GPU failed at frame ${i + 1}, out of memory most likely (try a smaller --radius, or close other apps):\n  ${gpu.split('\n')[0]}`);
    const file = `${String(i + 1).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(dir, 'color', file), Buffer.from(r.color.split(',')[1], 'base64'));
    for (const pass of ['depth', 'normal']) fs.writeFileSync(path.join(dir, pass, file), Buffer.from(r[pass].split(',')[1], 'base64'));
    if (j % FPS === 0 || j === frames.length - 1 || r.waited > 10) console.log(`frame ${i + 1}/${n}${r.waited ? ` (waited ${r.waited} steps for tiles)` : ''} · ${((Date.now() - t1) / 1000 / (j + 1)).toFixed(2)} s a frame`);
  }
  if (errors.length) console.warn(`${errors.length} errors in the page; the first:\n  ${[...new Set(errors)].slice(0, 5).join('\n  ')}`);

  if (!stills) {
    const ff = (a) => { const p = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { cwd: OUT, stdio: 'inherit' }); if (p.status) throw new Error('ffmpeg failed'); };
    const enc = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    for (const pass of ['color', 'depth', 'normal']) ff(['-framerate', String(FPS), '-i', `${pass}/%04d.png`, ...enc, `${pass}.mp4`]);
    ff(['-i', 'color.mp4', '-i', 'depth.mp4', '-i', 'normal.mp4', '-filter_complex', '[0:v]scale=640:-2[a];[1:v]scale=640:-2[b];[2:v]scale=640:-2[c];[a][b][c]hstack=inputs=3', ...enc, 'compare.mp4']);
    console.log(`wrote ${OUT}/{color,depth,normal,compare}.mp4`);
  }
  console.log(`done: ${frames.length} frames in ${dir}`);
} finally {
  console.log(`memory: the machine's free memory fell to ${mem.low}%, its wired memory rose to ${mem.wired.toFixed(1)} GB`);
  ws.close();
  await quit();
}
