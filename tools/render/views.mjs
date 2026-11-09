// A fixed set of views of the city, each loaded fresh in headless Chrome and settled, then measured: a screenshot,
// the time a frame takes (the JavaScript of a frame, and the frame through to the GPU's finishing it, by reading a
// pixel back), draws and triangles, the page's heap and the machine's wired memory, and every error and warning the
// page logs. For comparing the client before and after a change, view by view.
//
//   npm run dev
//   node tools/render/views.mjs --label=before            # -> data/renders/views/before/<view>.png, metrics.json
//   node tools/render/views.mjs --label=after --only=oldsj,night
//   node tools/render/views.mjs --compare=before,after    # the two side by side: compare.png, and a table
//
//   --frames=40 --size=1280x720 --url=http://localhost:5280 --port=9335 --min-free=10 --chrome=<path>
//
// People on foot are left out of every view (people=0): with a crowd in view, Chrome's GPU layer on Metal takes
// gigabytes (see tools/render/flythrough.mjs, Memory). The render stops if the machine's free memory falls below
// --min-free.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? '1']));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const OUTROOT = path.join(ROOT, 'data/renders/views');

// cam: x, z (east, south of Plaza de Armas), distance, azimuth (0: from the south), elevation, as main.js reads ?cam
const VIEWS = {
  opening: { q: 'time=16.5&clouds=0.3' },                                                  // the area's own first view
  oldsj: { q: 'time=10.5&clouds=0.3&cam=100,25,32,90,6' },                                 // Calle de la Fortaleza, at eye level, looking west
  condado: { q: 'time=17&clouds=0.3&cam=4647,990,650,180,16' },                            // Ashford's hotels from over the Atlantic
  hatorey: { q: 'time=15&clouds=0.3&cam=5883,4128,750,45,24' },                            // the Milla de Oro's towers
  expressway: { q: 'time=12&clouds=0.3&cam=4810,6419,160,0,11' },                          // Las Américas, low, looking north
  morning: { q: 'time=7.75&clouds=0.3&cam=7048,2006,260,30,20', sim: true },              // Baldorioty in the simulated morning
  night: { q: 'time=21&cam=3000,1600,4200,38,24' },                                        // the city at night
  sunset: { q: 'time=18.2&clouds=0.3&cam=-100,-50,1500,-45,9' },                          // over the bay to Old San Juan at sundown
};

const FRAMES = Number(args.frames ?? 40), [W, H] = (args.size ?? '1280x720').split('x').map(Number);
const URL0 = args.url ?? 'http://localhost:5280', PORT = Number(args.port ?? 9335), MIN_FREE = Number(args['min-free'] ?? 10);
const CHROME = args.chrome ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeNow = () => Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_level']).stdout) || 100;
const wiredGB = () => Number(spawnSync('vm_stat').stdout.toString().match(/Pages wired down:\s+(\d+)/)?.[1] ?? 0) * 16384 / 2 ** 30;

if (args.compare) { compare(...args.compare.split(',')); process.exit(0); }

const label = args.label ?? 'now', OUT = path.join(OUTROOT, label);
fs.mkdirSync(OUT, { recursive: true });
const only = args.only ? args.only.split(',') : Object.keys(VIEWS);
const results = fs.existsSync(path.join(OUT, 'metrics.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'metrics.json'), 'utf8')) : {};
for (const name of only) {
  if (!VIEWS[name]) { console.error(`no view "${name}"; views: ${Object.keys(VIEWS).join(', ')}`); continue; }
  let r = await measure(name, VIEWS[name]);
  // (the dev server reloads an open page when a source file has changed: the first view after an edit can be cut off)
  if (/navigated or closed/.test(r.error ?? '')) r = await measure(name, VIEWS[name]);
  results[name] = r;
  fs.writeFileSync(path.join(OUT, 'metrics.json'), JSON.stringify(results, null, 1));
  console.log(`${name.padEnd(11)} ${r.error ? 'FAILED ' + r.error : `frame ${r.cpu.toFixed(1)} ms JS, ${r.total.toFixed(1)} ms to the GPU's end (p90 ${r.p90.toFixed(1)}) · ${r.calls} draws · ${(r.tris / 1e6).toFixed(2)}M tris · heap ${r.heapMB} MB · wired ${r.wiredGB} GB · free ${r.free}% · loaded in ${r.loadS} s${r.errors.length ? ` · ${r.errors.length} errors/warnings` : ''}`}`);
  for (const e of r.errors ?? []) console.log(`             ${e}`);
}

async function measure(name, view) {
  const page = `${URL0}/?area=sanjuan&quality=high&people=0&xp=0&${view.q}${view.sim ? '' : '&sim=0'}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'views-'));
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--use-angle=metal', `--user-data-dir=${profile}`, '--enable-precise-memory-info',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise((r) => chrome.once('exit', r));
  let starved = false;
  const guard = setInterval(() => { if (freeNow() < MIN_FREE && !starved) { starved = true; console.error(`  free memory below ${MIN_FREE}%: stopping Chrome`); chrome.kill('SIGKILL'); } }, 500);
  const quit = async () => {
    clearInterval(guard);
    try { chrome.kill(); } catch { /* gone */ }
    await Promise.race([exited, sleep(5000)]);
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  };
  const errors = new Set();
  let ws;
  try {
    let target;
    for (let i = 0; i < 100 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null); }
    if (!target) throw new Error('Chrome did not start');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waiting = new Map();
    ws.onclose = () => { for (const { rej } of waiting.values()) rej(new Error(starved ? 'stopped: out of memory' : 'Chrome closed')); waiting.clear(); };
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && waiting.has(d.id)) { const { res, rej } = waiting.get(d.id); waiting.delete(d.id); if (d.error) rej(new Error(d.error.message)); else res(d.result); return; }
      const clip = (s) => String(s).split('\n').slice(0, 2).join(' | ').slice(0, 220);
      if (d.method === 'Runtime.exceptionThrown') errors.add('exception: ' + clip(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
      if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(d.params.type)) errors.add(`${d.params.type}: ` + clip(d.params.args.map((a) => a.value ?? a.description).join(' ')));
      if (d.method === 'Log.entryAdded' && ['error', 'warning'].includes(d.params.entry.level) && !/favicon/.test(d.params.entry.url ?? '')) errors.add(`log ${d.params.entry.level}: ` + clip(d.params.entry.text));
    };
    const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    const t0 = Date.now();
    await send('Page.navigate', { url: page });
    const r = await evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const until = async (ok, what, ms = 180000) => { const t0 = performance.now(); while (!ok()) { if (performance.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(100); } };
      await until(() => window.__app && document.getElementById('loader')?.classList.contains('done') && window.__app.atmosphere.ready, 'the city to load');
      const A = window.__app, loadS = performance.now() / 1000;
      window.requestAnimationFrame = () => 0; // (frames are stepped from here)
      await sleep(250);
      const gl = A.renderer.getContext(), px = new Uint8Array(4);
      const step = () => A.frame(1 / 30);
      // settle: every tile in view in (and a little longer for the clouds' and the occlusion's history)
      for (let k = 0; k < 1500 && (A.streamer.pending || k < 60); k++) { step(); await sleep(k < 60 ? 10 : 30); }
      const cpu = [], total = [];
      for (let k = 0; k < ${FRAMES}; k++) {
        const t0 = performance.now(); step(); const t1 = performance.now();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); const t2 = performance.now();
        cpu.push(t1 - t0); total.push(t2 - t0);
        await sleep(5);
      }
      step();
      const info = A.renderer.info, sorted = (a) => [...a].sort((x, y) => x - y), med = (a) => sorted(a)[a.length >> 1];
      return { loadS: +loadS.toFixed(1), cpu: med(cpu), total: med(total), p90: sorted(total)[Math.floor(total.length * 0.9)],
        calls: info.render.calls, tris: info.render.triangles, programs: info.programs.length, textures: info.memory.textures, geometries: info.memory.geometries,
        heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), png: A.renderer.domElement.toDataURL('image/png') };
    })()`);
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
    delete r.png;
    return { ...r, wiredGB: +wiredGB().toFixed(1), free: freeNow(), wallS: Math.round((Date.now() - t0) / 1000), errors: [...errors] };
  } catch (e) {
    return { error: e.message, errors: [...errors] };
  } finally {
    ws?.close();
    await quit();
  }
}

// two runs side by side: each view's pictures one above the other, and the numbers
function compare(a, b) {
  const A = JSON.parse(fs.readFileSync(path.join(OUTROOT, a, 'metrics.json'), 'utf8')), B = JSON.parse(fs.readFileSync(path.join(OUTROOT, b, 'metrics.json'), 'utf8'));
  const dir = path.join(OUTROOT, `${a}-vs-${b}`); fs.mkdirSync(dir, { recursive: true });
  for (const v of Object.keys(VIEWS)) {
    const x = A[v], y = B[v];
    if (!x || !y) continue;
    const d = (k, f = 1) => (x[k] != null && y[k] != null ? `${(x[k] * f).toFixed(1)} → ${(y[k] * f).toFixed(1)}` : '-');
    console.log(`${v.padEnd(11)} total ms ${d('total')} · JS ms ${d('cpu')} · draws ${d('calls')} · Mtris ${d('tris', 1e-6)} · heap MB ${d('heapMB')} · errors ${x.errors?.length ?? '-'} → ${y.errors?.length ?? '-'}`);
    const pa = path.join(OUTROOT, a, `${v}.png`), pb = path.join(OUTROOT, b, `${v}.png`);
    if (fs.existsSync(pa) && fs.existsSync(pb)) spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', pa, '-i', pb, '-filter_complex', '[0:v]scale=960:-2[a];[1:v]scale=960:-2[b];[a][b]hstack=inputs=2', path.join(dir, `${v}.png`)]);
  }
  console.log(`side by side in ${dir}`);
}
