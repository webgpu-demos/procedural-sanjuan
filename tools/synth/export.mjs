// Synthetic drone images with labels, from the city in a headless Chrome (src/synth/synth.js does the work in the
// page). Writes a dataset in the layout Ultralytics YOLO reads, plus masks and per-frame metadata:
//   <out>/images/{train,val}/<area>_<n>.jpg      the picture
//   <out>/labels/{train,val}/<area>_<n>.txt      YOLO boxes: "<class> <cx> <cy> <w> <h>", normalised
//   <out>/masks/<area>_<n>.png                   instance ids: R = class + 1, G * 256 + B = instance number in the frame
//   <out>/meta/<area>_<n>.json                   pose, hour, damage, every instance (box, pixels, building GERS id)
//   <out>/dataset.yaml                           classes and splits, for `yolo train data=<out>/dataset.yaml`
//   <out>/run.json                               the options of the run
// Run the client first (npm run dev, or a built copy served anywhere), then for example:
//   node tools/synth/export.mjs --url=http://localhost:5173/ --area=sanjuan --frames=400 --damage=0.25 --out=data/synth/sj
// Needs Chrome (or Chromium): found in the usual places, or --chrome=<path> / CHROME=<path>. puppeteer-core drives it.
// Options (defaults):
//   --frames=200 --size=1280x960 --hfov=73.7 (a DJI Phantom 4 / Mavic class camera) --alt=50,120 (m above ground)
//   --pitch=-90,-70 (degrees; -90 looks straight down) --hour=8.5,16.5 --damage=0.2 (share of low buildings with a
//   tarp and debris) --box=lon0,lat0,lon1,lat1 (default: the area) --seed=1 --val=0.1 --min-pixels=40
//   --max-block=0.02 (skip a frame when more than this share of it is distant unlabelled blocks) --ortho (drape the
//   aerial photo on the ground: real, but it carries the real roofs and cars, unlabelled; off by default)
//   --cars=300 (random traffic around the view) --masks / --no-masks --min-buildings=20 (shots only over 256 m tiles
//   holding at least this many buildings: not over the sea or a park)
import fs from 'node:fs';
import path from 'node:path';

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : process.argv.includes(`--${k}`) ? true : d; };
const range = (s) => String(s).split(',').map(Number);
const O = {
  url: arg('url', 'http://localhost:5173/'), area: arg('area', 'sanjuan'), out: path.resolve(arg('out', 'data/synth/out')),
  frames: Number(arg('frames', 200)), size: String(arg('size', '1280x960')).split('x').map(Number), hfov: Number(arg('hfov', 73.7)),
  alt: range(arg('alt', '50,120')), pitch: range(arg('pitch', '-90,-70')), hour: range(arg('hour', '8.5,16.5')), damage: Number(arg('damage', 0.2)),
  box: arg('box', null), seed: Number(arg('seed', 1)), val: Number(arg('val', 0.1)), minPixels: Number(arg('min-pixels', 40)), maxBlock: Number(arg('max-block', 0.02)),
  ortho: !!arg('ortho', false), minBuildings: Number(arg('min-buildings', 20)), cars: Number(arg('cars', 300)), masks: !arg('no-masks', false), chrome: arg('chrome', process.env.CHROME || null), timeout: Number(arg('timeout', 180)),
};
const NAMES = ['building', 'blue_tarp', 'debris', 'vehicle'];

function findChrome() {
  if (O.chrome) return O.chrome;
  const c = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
  const f = c.find((p) => fs.existsSync(p));
  if (!f) throw new Error('no Chrome found: pass --chrome=<path to Chrome or Chromium>');
  return f;
}

const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(0).padStart(5) + 's', ...a);
const { default: puppeteer } = await import('puppeteer-core');
const [W, H] = O.size;
// (SYNTH_CHROME_ARGS: more switches for an unusual Chrome build; SYNTH_HEADLESS=shell for chrome-headless-shell)
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: process.env.SYNTH_HEADLESS === 'shell' ? 'shell' : true, protocolTimeout: 600000,
  args: [...(process.env.SYNTH_CHROME_ARGS ? process.env.SYNTH_CHROME_ARGS.split(' ') : []), `--window-size=${W},${H}`, '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--enable-webgl', '--no-sandbox'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => log('page error:', e.message));
const u = new URL(O.url);
Object.entries({ area: O.area, quality: 'high', xp: '0', sim: '0', ortho: O.ortho ? '1' : '0', time: String(O.hour[0]), cars: String(O.cars) }).forEach(([k, v]) => u.searchParams.set(k, v));
log('opening', u.href);
await page.goto(u.href, { waitUntil: 'load', timeout: O.timeout * 1000 });
await page.waitForFunction(() => window.__app && document.getElementById('loader')?.classList.contains('done'), { timeout: O.timeout * 1000, polling: 1000 });
log('city loaded');

const plan = await page.evaluate(async (o) => {
  const app = window.__app, s = await app.synth;
  s.configure({ damage: o.damage, seed: o.seed });
  let box;
  if (o.box) {
    const [lon0, lat0, lon1, lat1] = o.box.split(',').map(Number), [x0, z0] = app.proj.project(lon0, lat1), [x1, z1] = app.proj.project(lon1, lat0);
    box = [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];
  } else { const b = app.manifest.bounds; box = [b.minX, b.minZ, b.maxX, b.maxZ]; }
  return s.plan({ box, alt: o.alt, pitch: o.pitch, hfov: o.hfov, aspect: o.W / o.H, max: Math.ceil(o.frames * 1.3), seed: o.seed, minBuildings: o.minBuildings });
}, { ...O, W, H });
log(`${plan.length} poses planned`);

for (const d of ['images/train', 'images/val', 'labels/train', 'labels/val', 'meta', ...(O.masks ? ['masks'] : [])]) fs.mkdirSync(path.join(O.out, d), { recursive: true });
const counts = { frames: 0, skipped: 0, instances: [0, 0, 0, 0] };
let x = O.seed * 7919 + 1;
const rand = () => { x = (x * 48271) % 2147483647; return x / 2147483647; };
for (let i = 0; i < plan.length && counts.frames < O.frames; i++) {
  const p = plan[i], hour = O.hour[0] + rand() * (O.hour[1] - O.hour[0]);
  const shot = await page.evaluate(async (p, hour, o) => {
    const app = window.__app, s = await app.synth;
    app.clockTime.live = false; app.clockTime.hour = hour;
    const pose = s.pose({ ...p, hfov: o.hfov });
    const ok = await s.ready(o.timeout * 1000);
    const c = await s.capture({ minPixels: o.minPixels, withIds: o.masks });
    const [lon, lat] = app.proj.unproject(p.x, p.z);
    return { ...c, ok, pose: { ...p, ...pose, lon, lat, hour } };
  }, p, hour, O);
  const name = `${O.area}_${String(i).padStart(5, '0')}`;
  if (!shot.ok || shot.share.block > O.maxBlock) { counts.skipped++; log(`${name}: skipped (${shot.ok ? `${(shot.share.block * 100).toFixed(1)} % distant blocks` : 'tiles did not load'})`); continue; }
  const split = rand() < O.val ? 'val' : 'train';
  fs.writeFileSync(path.join(O.out, 'images', split, `${name}.jpg`), Buffer.from(shot.image.split(',')[1], 'base64'));
  if (O.masks && shot.ids) fs.writeFileSync(path.join(O.out, 'masks', `${name}.png`), Buffer.from(shot.ids.split(',')[1], 'base64'));
  const lines = shot.instances.map((r) => {
    counts.instances[r.cls]++;
    const [x0, y0, x1, y1] = r.box;
    return `${r.cls} ${((x0 + x1) / 2 / shot.width).toFixed(6)} ${((y0 + y1) / 2 / shot.height).toFixed(6)} ${((x1 - x0) / shot.width).toFixed(6)} ${((y1 - y0) / shot.height).toFixed(6)}`;
  });
  fs.writeFileSync(path.join(O.out, 'labels', split, `${name}.txt`), lines.join('\n') + (lines.length ? '\n' : ''));
  delete shot.image; delete shot.ids;
  fs.writeFileSync(path.join(O.out, 'meta', `${name}.json`), JSON.stringify({ name, split, area: O.area, damage: O.damage, seed: O.seed, ...shot }));
  counts.frames++;
  log(`${name} (${split}): ${shot.instances.length} instances [${NAMES.map((n, k) => `${n} ${shot.instances.filter((r) => r.cls === k).length}`).join(', ')}], alt ${p.alt.toFixed(0)} m, pitch ${p.pitch.toFixed(0)}°, ${hour.toFixed(1)} h`);
}
fs.writeFileSync(path.join(O.out, 'dataset.yaml'), [
  '# procedural-sanjuan synthetic drone images (tools/synth/export.mjs)', `path: ${O.out}`, 'train: images/train', 'val: images/val', 'names:', ...NAMES.map((n, k) => `  ${k}: ${n}`), '',
].join('\n'));
fs.writeFileSync(path.join(O.out, 'run.json'), JSON.stringify({ options: O, counts, finished: new Date().toISOString() }, null, 1));
log('done', JSON.stringify(counts));
await browser.close();
