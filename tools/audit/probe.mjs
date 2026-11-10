// A page of the city in headless Chrome (as tools/render/views.mjs runs it), settled, then a script evaluated in it.
//   node tools/audit/probe.mjs --q='time=12&cam=...' --js=file.js [--shot=out.png] [--size=1280x720] [--sim=1] [--port=9341] [--settle=60] [--xp=1: the opening on]
// The script file holds the body of an async function (A = window.__app, step(dt) = one frame, sleep(ms)); what it
// returns is printed as JSON. --shots: the script may return { shots: { name: dataURL } }, written beside --shot.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const s = a.replace(/^--/, ''), i = s.indexOf('='); return i < 0 ? [s, '1'] : [s.slice(0, i), s.slice(i + 1)]; }));
const [W, H] = (args.size ?? '1280x720').split('x').map(Number), PORT = Number(args.port ?? 9341);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freeNow = () => Number(spawnSync('sysctl', ['-n', 'kern.memorystatus_level']).stdout) || 100;
const body = args.js ? fs.readFileSync(args.js, 'utf8') : 'return null;';
const page = `${args.url ?? 'http://localhost:5280'}/?area=${args.area ?? 'sanjuan'}&quality=${args.quality ?? 'high'}&people=${args.people ?? 0}&xp=${args.xp ?? 0}&${args.q ?? ''}${args.sim ? '' : '&sim=0'}`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, '--use-angle=metal', `--user-data-dir=${profile}`, '--enable-precise-memory-info',
  `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--js-flags=--expose-gc',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
const exited = new Promise((r) => chrome.once('exit', r));
const guard = setInterval(() => { if (freeNow() < 8) { console.error('free memory below 8%: stopping Chrome'); chrome.kill('SIGKILL'); } }, 500);
const errors = new Set();
let ws, code = 0;
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) { await sleep(200); target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => null); }
  if (!target) throw new Error('Chrome did not start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map();
  ws.onclose = () => { for (const { rej } of waiting.values()) rej(new Error('Chrome closed')); waiting.clear(); };
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const { res, rej } = waiting.get(d.id); waiting.delete(d.id); if (d.error) rej(new Error(d.error.message)); else res(d.result); return; }
    const clip = (s) => String(s).split('\n').slice(0, 2).join(' | ').slice(0, 300);
    if (d.method === 'Runtime.exceptionThrown') errors.add('exception: ' + clip(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
    if (d.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'warn'].includes(d.params.type)) errors.add(`${d.params.type}: ` + clip(d.params.args.map((a) => a.value ?? a.description).join(' ')));
    if (d.method === 'Log.entryAdded' && ['error', 'warning'].includes(d.params.entry.level) && !/favicon/.test(d.params.entry.url ?? '')) errors.add(`log ${d.params.entry.level}: ` + clip(d.params.entry.text));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: Number(args.dpr ?? 1), mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.WebSocket = class { constructor() { this.readyState = 0; } addEventListener() {} removeEventListener() {} send() {} close() {} };' });
  await send('Page.navigate', { url: page });
  const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (ok, what, ms = 180000) => { const t0 = performance.now(); while (!ok()) { if (performance.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(100); } };
    await until(() => window.__app && document.getElementById('loader')?.classList.contains('done') && window.__app.atmosphere.ready, 'the city to load');
    const A = window.__app;
    window.requestAnimationFrame = () => 0;
    await sleep(250);
    const step = (dt = 1 / 30) => A.frame(dt);
    const settle = async (n = ${Number(args.settle ?? 60)}) => { for (let k = 0; k < 1500 && (A.streamer.pending || k < n); k++) { step(); await sleep(k < n ? 10 : 30); } };
    await settle();
    const shot = () => A.renderer.domElement.toDataURL('image/png');
    const out = await (async () => { ${body} })();
    step();
    return { out, png: ${args.shot ? 'shot()' : 'null'} };
  })()` });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  const v = r.result.value;
  if (args.shot && v.png) fs.writeFileSync(args.shot, Buffer.from(v.png.split(',')[1], 'base64'));
  if (v.out?.shots) { for (const [k, d] of Object.entries(v.out.shots)) fs.writeFileSync(path.join(path.dirname(args.shot ?? args.js), `${k}.png`), Buffer.from(d.split(',')[1], 'base64')); delete v.out.shots; }
  console.log(JSON.stringify(v.out, null, 1));
  if (errors.size) console.log('page errors/warnings:\n  ' + [...errors].join('\n  '));
} catch (e) { console.error('FAILED', e.message); for (const x of errors) console.error('  ' + x); code = 1; } finally {
  clearInterval(guard); ws?.close();
  try { chrome.kill(); } catch { /* gone */ }
  await Promise.race([exited, sleep(5000)]);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(code);
