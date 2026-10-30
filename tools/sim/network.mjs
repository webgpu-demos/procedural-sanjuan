// The city's road graph (public/tiles/<area>/roads.json, written by tools/pipeline/compile.mjs) as a SUMO
// network: the simulation drives on the same centrelines, lanes and levels the renderer paints, so every
// simulated car sits in a painted lane. The graph is the one road format: whatever supplies the centrelines
// (OSM today), SUMO and the renderer read them from here.
//
//   world (x east, z south, y up)  ->  SUMO (x east, y north, z up): (x, -z, y), no offset (the frames coincide)
//   edge i of roads.json            ->  SUMO edge "e<i>" along it, "r<i>" against it (two-way roads)
//
// A run of roads joined end to end with nothing else meeting them (OSM splits a way wherever a tag changes) is one
// SUMO edge, named after its last piece (the one that arrives at the junction): net/merged.json lists the pieces,
// for run.py to give each its speeds. (Each node is a junction SUMO builds; netconvert cuts the edges back to their
// junctions' shapes, and a piece between two close ones was left a metre or none long: a car could not stop on it,
// so it waited across the junction behind, and the streets locked one another.)
//
// Writes data/sim/<area>/net/{plain.nod.xml, plain.edg.xml, merged.json, lanes.json, inside.json} and runs netconvert to
// data/sim/<area>/<area>.net.xml.gz.
// Usage: node tools/sim/network.mjs [--area=sanjuan] [--no-merge] [--no-painted] [--no-zipper] [--no-ror] [--no-service] [--ramps] [--zip-ramps] [--join=18]
//        [--cluster=20] [--reach=45] [--netconvert=--opt,value,...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveArea, ROOT } from '../pipeline/config.mjs';
import { roadLanes, paintOf } from '../../src/shared/roadway.js';

const area = resolveArea();
const flag = (k) => !process.argv.includes(`--no-${k}`);
const opt = (k, d) => { const a = process.argv.find((v) => v.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };
const tiles = path.join(ROOT, 'public/tiles', area.id), out = path.join(ROOT, 'data/sim', area.id);
fs.mkdirSync(path.join(out, 'net'), { recursive: true });
const roads = JSON.parse(fs.readFileSync(path.join(tiles, 'roads.json'), 'utf8'));
const lanesFile = path.join(tiles, 'lanes.json');
const painted = flag('painted') && fs.existsSync(lanesFile) ? JSON.parse(fs.readFileSync(lanesFile, 'utf8')).edges : null;
const t0 = Date.now(), log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s ${m}`);

// junction priority by road class: who gives way to whom where there are no lights
const PRIORITY = { motorway: 13, trunk: 12, primary: 11, secondary: 10, tertiary: 9, unclassified: 7, residential: 6, living_street: 5, service: 4 };
const LANE = 3.0;   // lane width (m): roadsplit.mjs builds carriageways of 3 m lanes
const NARROW = 2.6; // a two-way street of one shared lane: two narrow ones, a car's width either side of the line
const WIDEST = 4.5; // (a lane no wider: a one-lane ramp is painted as wide as it is paved, 7 m; SUMO's junctions grow with it)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const f = (v) => Math.round(v * 100) / 100;
const fast = (e) => /^(motorway|trunk)(_link)?$/.test(e.highway);
const lanesOf = roadLanes(roads.edges);

// Driveways, car parks, a petrol station's forecourt (OSM's unnamed service ways: 430 km of them) are left out: where
// one met a signalled crossing, the lights gave it a phase of its own, and the avenue waited for an empty car park.
// (Named ones stay: the airport's departures and arrivals levels, a hospital's streets, a frontage road.)
const driveway = (e) => flag('service') && e.highway === 'service' && !e.name;
const edges = [];
roads.edges.forEach((e, i) => {
  if (e.a === e.b || driveway(e)) return;
  const pts = [];
  for (let k = 0; k < e.pts.length; k += 3) pts.push([e.pts[k], -e.pts[k + 2], e.pts[k + 1]]);
  let len = 0;
  for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  if (len < 0.5) return;
  const hw = e.highway.replace('_link', ''), link = e.highway.endsWith('_link');
  const priority = (PRIORITY[hw] ?? 5) - (link ? 1 : 0);
  const speed = Math.max(4, e.maxspeed / 3.6);
  const attrs = { src: i, priority, speed: f(speed), name: e.name ?? e.ref ?? '', fast: fast(e), link };
  if (e.oneway) {
    const p = e.oneway === -1 ? [...pts].reverse() : pts, [a, b] = e.oneway === -1 ? [e.b, e.a] : [e.a, e.b];
    // The expressway in the lanes the tiles paint (lanetable.mjs measured them from the carriageway; elsewhere, a ramp
    // or a deck, by the rule markings.mjs paints them with): the lanes OSM counts are sometimes more than are painted,
    // and a car rode down a painted line between two of them (src/world/simtraffic.js relane)
    let lanes = Math.max(1, e.lanes), width = LANE;
    if (painted && attrs.fast) {
      const t = painted[i], p = t ?? paintOf(e, Math.max(1, lanesOf(e) || e.lanes || 1));
      lanes = p.lanes; width = Math.min(WIDEST, p.lw);
    } else if (painted && lanes >= 2) {
      // (a street: its lanes as wide as they are painted, where the paint has as many)
      const p = paintOf(e, lanes);
      if (p.lanes === lanes) width = Math.min(WIDEST, p.lw);
    }
    edges.push({ id: `e${i}`, from: a, to: b, lanes, width, spread: 'center', pts: p, ...attrs });
  } else {
    // lanes each way: the tagged split, else half the road each (a single shared lane: one narrow lane each way)
    const fwd = e.lanesForward ?? (e.lanes >= 2 ? Math.floor(e.lanes / 2) : 1);
    const bwd = e.lanesBackward ?? (e.lanes >= 2 ? Math.max(1, e.lanes - fwd) : 1);
    let width = e.lanes >= 2 ? LANE : NARROW;
    if (painted && fwd === bwd && fwd >= 1 && e.lanes >= 2) {
      // (the lanes as wide as they are painted, where the paint divides the street into as many, half each way)
      const p = paintOf(e, fwd + bwd);
      if (p.lanes === fwd + bwd) width = Math.min(WIDEST, p.lw);
    }
    edges.push({ id: `e${i}`, from: e.a, to: e.b, lanes: fwd, width, spread: 'right', pts, ...attrs });
    edges.push({ id: `r${i}`, from: e.b, to: e.a, lanes: bwd, width, spread: 'right', pts: [...pts].reverse(), ...attrs });
  }
});

// Lane drops. OSM draws a toll plaza as stretches of five, six or eight lanes, and where a road narrows SUMO
// connects only as many lanes as there are beyond: the rest are dead ends whose drivers must find a gap at
// walking pace, and at the rush hour the expressway stops there (PR-22 at Buchanan, 6 lanes into 2 and an exit,
// locked the west side of the city). An expressway stretch is made at most one lane wider than all the lanes
// leaving its end, from the end back upstream, so a road narrows a lane at a time as drivers merge.
{
  const outOf = new Map();
  for (const e of edges) if (e.fast) (outOf.get(e.from) ?? outOf.set(e.from, []).get(e.from)).push(e);
  let n = 0;
  for (let pass = 0; pass < 6; pass++) {
    let changed = 0;
    for (const e of edges) {
      if (!e.fast || e.link) continue;
      const on = (outOf.get(e.to) ?? []).filter((o) => o.src !== e.src); // (not the other way back)
      if (!on.length) continue;
      const room = on.reduce((s, o) => s + o.lanes, 0) + 1;
      if (e.lanes > room) { e.lanes = room; changed++; }
    }
    n += changed;
    if (!changed) break;
  }
  log(`${n} expressway stretches narrowed to the lanes beyond them`);
}

const signals = new Set(roads.signals);
// the lanes SUMO drives each one-way expressway piece with, and their width (run.py puts them in the run's index:
// the client moves each car from SUMO's lanes into the painted ones)
const laneTable = {};
for (const e of edges) if (e.fast && e.spread === 'center') laneTable[e.src] = [e.lanes, f(e.width)];

// Runs of pieces: a node that only joins two roads (no light, nothing else meeting there), the same road either side
// (lanes, width, class, speed), joins them.
const inAt = new Map(), outAt = new Map();
for (const e of edges) {
  (inAt.get(e.to) ?? inAt.set(e.to, []).get(e.to)).push(e);
  (outAt.get(e.from) ?? outAt.set(e.from, []).get(e.from)).push(e);
}
const merged = {};
let mergedEdges = edges;
if (flag('merge')) {
  const same = (a, b) => a.lanes === b.lanes && Math.abs(a.width - b.width) < 0.35 && a.priority === b.priority &&
    Math.abs(a.speed - b.speed) < 0.6 && a.spread === b.spread && a.fast === b.fast && a.link === b.link;
  const next = new Map(), prev = new Map();
  for (const [node, ins] of inAt) {
    if (signals.has(node)) continue;
    const outs = outAt.get(node) ?? [];
    const srcs = new Set([...ins, ...outs].map((e) => e.src));
    if (srcs.size !== 2 || ins.length !== outs.length || ins.length > 2) continue;
    const pairs = ins.map((a) => [a, outs.find((b) => b.src !== a.src)]);
    if (pairs.some(([a, b]) => !b || !same(a, b))) continue;
    for (const [a, b] of pairs) { next.set(a, b); prev.set(b, a); }
  }
  mergedEdges = [];
  const done = new Set();
  const emit = (chain) => {
    for (const e of chain) done.add(e);
    if (chain.length === 1) { mergedEdges.push(chain[0]); return; }
    const last = chain.at(-1), pts = [...chain[0].pts];
    for (const e of chain.slice(1)) pts.push(...e.pts.slice(1));
    mergedEdges.push({ ...chain[0], id: last.id, to: last.to, pts, name: chain.find((e) => e.name)?.name ?? '' });
    merged[last.id] = chain.map((e) => e.id);
  };
  for (const e of edges) {
    if (done.has(e) || prev.has(e)) continue;
    const chain = [e];
    for (let n = next.get(e); n && !done.has(n) && !chain.includes(n); n = next.get(n)) chain.push(n);
    emit(chain);
  }
  for (const e of edges) if (!done.has(e)) emit([e]); // (a ring of pieces with no end: left as it is)
  log(`${edges.length - mergedEdges.length} joins: ${mergedEdges.length} edges`);
}

// Nodes: lights (right on red, as Puerto Rico drives: after a stop, unless a sign says otherwise), and where two
// expressway carriageways join into fewer lanes than they bring, a zipper (each lane's drivers in turn: a priority
// junction made one of them wait for a gap that, at the rush hour, never came). (A ramp is not a zipper: the
// expressway's own lanes took turns with the ramp's. Nor does netconvert guess it a lane of its own, --ramps.guess:
// it widened the road beyond what the tiles pave, a lane or two for 100 m where any ramp met one, Avenida Piñero
// included, and moved the road's lanes over to make room: 73 km of lanes in San Juan where a car stood past the
// paving, off a deck's edge or on the sidewalk, 25 km without. --ramps brings the guessing back.)
const used = new Map(); // node -> [in, out]
for (const e of mergedEdges) {
  (used.get(e.from) ?? used.set(e.from, [[], []]).get(e.from))[1].push(e);
  (used.get(e.to) ?? used.set(e.to, [[], []]).get(e.to))[0].push(e);
}
// Junctions OSM draws as several nodes a few metres apart (a dual carriageway crossing a street: four), joined into
// one: netconvert's own joining (--junctions.join) leaves many of them apart, the pieces between them cut back to
// nothing by the junctions' shapes, and SUMO then locks them against one another. Nodes where three or more roads
// meet, or lights, joined along a piece shorter than CLUSTER metres, as long as the whole stays within REACH.
const CLUSTER = +opt('cluster', 20), REACH = +opt('reach', 45);
const parent = new Map(), members = new Map();
const find = (k) => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
const roadsAt = (k) => new Set([...used.get(k)[0], ...used.get(k)[1]].map((e) => e.src)).size;
const xz = (k) => [roads.nodes[k][0], roads.nodes[k][2]];
let joins = 0;
if (CLUSTER > 0) {
  const junction = (k) => signals.has(k) || roadsAt(k) >= 3;
  for (const k of used.keys()) if (junction(k)) { parent.set(k, k); members.set(k, [k]); }
  const len2d = (e) => { let s = 0; for (let i = 1; i < e.pts.length; i++) s += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]); return s; };
  const short = mergedEdges.filter((e) => parent.has(e.from) && parent.has(e.to) && len2d(e) < CLUSTER).sort((a, b) => len2d(a) - len2d(b));
  for (const e of short) {
    const a = find(e.from), b = find(e.to);
    if (a === b) continue;
    const all = [...members.get(a), ...members.get(b)];
    let wide = false;
    for (let i = 0; i < all.length && !wide; i++) for (let j = i + 1; j < all.length; j++) {
      const [x0, z0] = xz(all[i]), [x1, z1] = xz(all[j]);
      if (Math.hypot(x1 - x0, z1 - z0) > REACH) { wide = true; break; }
    }
    if (wide) continue;
    parent.set(b, a); members.set(a, all); members.delete(b); joins++;
  }
}
const clusters = [...members.values()].filter((m) => m.length > 1);
log(`${clusters.length} junctions joined from ${clusters.reduce((s, m) => s + m.length, 0)} nodes`);
const inCluster = new Set(clusters.flat());
// The pieces inside a joined junction are no longer SUMO's edges (its internal lanes drive them): a signal head
// over one shows the lights of the way in that carries straight on along it (run.py: signals.json links)
const inside = {};
{
  const root = (k) => (parent.has(k) ? find(k) : k);
  const heading = (p, end) => { const [a, b] = end ? [p.at(-2), p.at(-1)] : [p[0], p[1]]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]; };
  for (const e of mergedEdges) {
    if (!inCluster.has(e.from) || root(e.from) !== root(e.to)) continue;
    const h = heading(e.pts, false);
    let best = null, bd = -2;
    for (const o of used.get(e.from)[0]) {
      if (inCluster.has(o.from) && root(o.from) === root(e.from)) continue; // (another piece inside)
      const g = heading(o.pts, true), d = g[0] * h[0] + g[1] * h[1];
      if (d > bd) { bd = d; best = o; }
    }
    if (best) for (const id of merged[e.id] ?? [e.id]) inside[id] = best.id;
  }
}

// (a joined junction is one node, where its nodes were on average, a light if any of them was one; netconvert's own
// <join> made a joined junction of lights a priority junction: 430 of the 658 lights went out)
const lightType = flag('ror') ? 'traffic_light_right_on_red' : 'traffic_light';
const nodeId = new Map(); // roads node -> SUMO node id
for (const m of clusters) for (const k of m) nodeId.set(k, `c${Math.min(...m)}`);
const idOf = (k) => nodeId.get(k) ?? `n${k}`;
let zips = 0, lights = 0;
// (--zip-ramps: a ramp that joins the expressway in fewer lanes than they bring, a zipper too: the ramp and the
// outer lane take turns, the other lanes drive on; without its guessed acceleration lane it gave way to the outer
// lane, waiting for a gap)
const zipRamps = process.argv.includes('--zip-ramps');
const nodeXml = ['<nodes>'];
for (const [k, [ins, outs]] of used) {
  if (nodeId.has(k)) continue;
  const [x, y, z] = roads.nodes[k];
  let type = '';
  if (signals.has(k)) { type = lightType; lights++; }
  else if (flag('zipper') && ins.length >= 2 && outs.length === 1 && [...ins, ...outs].every((e) => e.fast && e.spread === 'center') &&
    (!ins.some((e) => e.link) || zipRamps) && ins.reduce((s, e) => s + e.lanes, 0) > outs[0].lanes) { type = 'zipper'; zips++; }
  nodeXml.push(`  <node id="n${k}" x="${f(x)}" y="${f(-z)}" z="${f(y)}"${type ? ` type="${type}"` : ''}/>`);
}
for (const m of clusters) {
  const p = m.map((k) => roads.nodes[k]), avg = (j) => p.reduce((s, q) => s + q[j], 0) / p.length;
  const lit = m.some((k) => signals.has(k));
  if (lit) lights++;
  nodeXml.push(`  <node id="${idOf(m[0])}" x="${f(avg(0))}" y="${f(-avg(2))}" z="${f(avg(1))}"${lit ? ` type="${lightType}"` : ''}/>`);
}
nodeXml.push('</nodes>');
const shape = (p) => p.map(([x, y, z]) => `${f(x)},${f(y)},${f(z)}`).join(' ');
const edgeXml = ['<edges>'];
let dropped = 0;
for (const e of mergedEdges) {
  const a = idOf(e.from), b = idOf(e.to);
  if (a === b && nodeId.has(e.from)) { dropped++; continue; } // (inside a joined junction: its internal lanes drive it)
  edgeXml.push(`  <edge id="${e.id}" from="${a}" to="${b}" priority="${e.priority}" numLanes="${e.lanes}" speed="${e.speed}" width="${f(e.width)}"` +
    ` spreadType="${e.spread}"${e.name ? ` name="${esc(e.name)}"` : ''} shape="${shape(e.pts)}"/>`);
}
edgeXml.push('</edges>');
fs.writeFileSync(path.join(out, 'net/plain.nod.xml'), nodeXml.join('\n'));
fs.writeFileSync(path.join(out, 'net/plain.edg.xml'), edgeXml.join('\n'));
fs.writeFileSync(path.join(out, 'net/merged.json'), JSON.stringify(merged));
fs.writeFileSync(path.join(out, 'net/lanes.json'), JSON.stringify(laneTable));
fs.writeFileSync(path.join(out, 'net/inside.json'), JSON.stringify(inside));
log(`plain network: ${used.size - nodeId.size + clusters.length} nodes (${lights} with lights, ${zips} zippers), ` +
  `${mergedEdges.length - dropped} directed edges from ${roads.edges.length} roads`);

const bin = path.join(ROOT, '.venv-sim/bin/netconvert');
const netFile = path.join(out, `${area.id}.net.xml.gz`);
execFileSync(bin, [
  '--node-files', path.join(out, 'net/plain.nod.xml'), '--edge-files', path.join(out, 'net/plain.edg.xml'),
  '--output-file', netFile,
  '--offset.disable-normalization',                 // SUMO's frame is the world's
  '--junctions.join', '--junctions.join-dist', opt('join', '18'), // a crossing OSM draws as several nodes is one junction
  ...(process.argv.includes('--ramps') ? ['--ramps.guess'] : []), // (acceleration and deceleration lanes: see the zippers above)
  '--tls.join', '--tls.default-type', 'actuated',    // (the heads show what the run recorded: simsignals.js)
  '--default.junctions.type', 'priority',            // (not right-before-left: Puerto Rico's side streets give way to the main road)
  '--no-turnarounds.except-deadend',
  '--remove-edges.isolated',
  '--output.street-names',
  '--no-warnings', '--ignore-errors',
  ...(opt('netconvert', '') ? opt('netconvert', '').split(',') : []),
], { stdio: 'inherit' });
log(`netconvert -> ${path.relative(ROOT, netFile)} (${(fs.statSync(netFile).size / 1e6).toFixed(1)} MB)`);
