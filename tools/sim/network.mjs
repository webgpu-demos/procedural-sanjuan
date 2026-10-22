// The city's road graph (public/tiles/<area>/roads.json, written by tools/pipeline/compile.mjs) as a SUMO
// network: the simulation drives on the same centrelines, lanes and levels the renderer paints, so every
// simulated car sits in a painted lane. The graph is the one road format: whatever supplies the centrelines
// (OSM today), SUMO and the renderer read them from here.
//
//   world (x east, z south, y up)  ->  SUMO (x east, y north, z up): (x, -z, y), no offset (the frames coincide)
//   edge i of roads.json            ->  SUMO edge "e<i>" along it, "r<i>" against it (two-way roads)
//
// Writes data/sim/<area>/net/{plain.nod.xml, plain.edg.xml} and runs netconvert to data/sim/<area>/<area>.net.xml.gz.
// Usage: node tools/sim/network.mjs [--area=sanjuan]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveArea, ROOT } from '../pipeline/config.mjs';

const area = resolveArea();
const tiles = path.join(ROOT, 'public/tiles', area.id), out = path.join(ROOT, 'data/sim', area.id);
fs.mkdirSync(path.join(out, 'net'), { recursive: true });
const roads = JSON.parse(fs.readFileSync(path.join(tiles, 'roads.json'), 'utf8'));
const t0 = Date.now(), log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);

// junction priority by road class: who gives way to whom where there are no lights
const PRIORITY = { motorway: 13, trunk: 12, primary: 11, secondary: 10, tertiary: 9, unclassified: 7, residential: 6, living_street: 5, service: 4 };
const LANE = 3.0;   // lane width (m): roadsplit.mjs builds carriageways of 3 m lanes
const NARROW = 2.6; // a two-way street of one shared lane: two narrow ones, a car's width either side of the line
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const f = (v) => Math.round(v * 100) / 100;

const used = new Set();
const edges = [];
roads.edges.forEach((e, i) => {
  if (e.a === e.b) return;
  const pts = [];
  for (let k = 0; k < e.pts.length; k += 3) pts.push([e.pts[k], -e.pts[k + 2], e.pts[k + 1]]);
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  if (len < 0.5) return;
  const hw = e.highway.replace('_link', ''), link = e.highway.endsWith('_link');
  const priority = (PRIORITY[hw] ?? 5) - (link ? 1 : 0);
  const speed = Math.max(4, e.maxspeed / 3.6);
  const attrs = { priority, speed: f(speed), name: e.name ?? e.ref ?? '' };
  const shape = (p) => p.map(([x, y, z]) => `${f(x)},${f(y)},${f(z)}`).join(' ');
  if (e.oneway) {
    const p = e.oneway === -1 ? [...pts].reverse() : pts, [a, b] = e.oneway === -1 ? [e.b, e.a] : [e.a, e.b];
    edges.push({ id: `e${i}`, from: a, to: b, lanes: Math.max(1, e.lanes), width: LANE, spread: 'center', shape: shape(p), ...attrs });
    used.add(a); used.add(b);
  } else {
    // lanes each way: the tagged split, else half the road each (a single shared lane: one narrow lane each way)
    const fwd = e.lanesForward ?? (e.lanes >= 2 ? Math.floor(e.lanes / 2) : 1);
    const bwd = e.lanesBackward ?? (e.lanes >= 2 ? Math.max(1, e.lanes - fwd) : 1);
    const width = e.lanes >= 2 ? LANE : NARROW;
    edges.push({ id: `e${i}`, from: e.a, to: e.b, lanes: fwd, width, spread: 'right', shape: shape(pts), ...attrs });
    edges.push({ id: `r${i}`, from: e.b, to: e.a, lanes: bwd, width, spread: 'right', shape: shape([...pts].reverse()), ...attrs });
    used.add(e.a); used.add(e.b);
  }
});

const signals = new Set(roads.signals);
const nodeXml = ['<nodes>'];
for (const k of used) {
  const [x, y, z] = roads.nodes[k];
  nodeXml.push(`  <node id="n${k}" x="${f(x)}" y="${f(-z)}" z="${f(y)}"${signals.has(k) ? ' type="traffic_light"' : ''}/>`);
}
nodeXml.push('</nodes>');
const edgeXml = ['<edges>'];
for (const e of edges) {
  edgeXml.push(`  <edge id="${e.id}" from="n${e.from}" to="n${e.to}" priority="${e.priority}" numLanes="${e.lanes}" speed="${e.speed}" width="${e.width}"` +
    ` spreadType="${e.spread}"${e.name ? ` name="${esc(e.name)}"` : ''} shape="${e.shape}"/>`);
}
edgeXml.push('</edges>');
fs.writeFileSync(path.join(out, 'net/plain.nod.xml'), nodeXml.join('\n'));
fs.writeFileSync(path.join(out, 'net/plain.edg.xml'), edgeXml.join('\n'));
log(`plain network: ${used.size} nodes (${[...used].filter((k) => signals.has(k)).length} with lights), ${edges.length} directed edges from ${roads.edges.length} roads`);

const bin = path.join(ROOT, '.venv-sim/bin/netconvert');
const netFile = path.join(out, `${area.id}.net.xml.gz`);
execFileSync(bin, [
  '--node-files', path.join(out, 'net/plain.nod.xml'), '--edge-files', path.join(out, 'net/plain.edg.xml'),
  '--output-file', netFile,
  '--offset.disable-normalization',                 // SUMO's frame is the world's
  '--junctions.join', '--junctions.join-dist', '18', // a crossing OSM draws as several nodes is one junction
  '--ramps.guess',                                   // acceleration and deceleration lanes on the expressway ramps
  '--tls.join', '--tls.default-type', 'actuated',    // (the heads show what the run recorded: simsignals.js)
  '--default.junctions.type', 'priority',            // (not right-before-left: Puerto Rico's side streets give way to the main road)
  '--no-turnarounds.except-deadend',
  '--remove-edges.isolated',
  '--output.street-names',
  '--no-warnings', '--ignore-errors',
], { stdio: 'inherit' });
log(`netconvert -> ${path.relative(ROOT, netFile)} (${(fs.statSync(netFile).size / 1e6).toFixed(1)} MB)`);
