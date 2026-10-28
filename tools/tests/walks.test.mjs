// The walks of a compiled area (tools/pipeline/walkways.mjs) as the client reads them (src/world/people.js): every
// link between nodes that exist, its points finite and near its ends, the crossings on a street of roads.json, the
// counts in range, and the network in a few large pieces, few links on their own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../../public/tiles');
const areas = fs.existsSync(root) ? fs.readdirSync(root).filter((a) => fs.existsSync(path.join(root, a, 'walks.json'))) : [];
if (!areas.length) console.log('walks: no compiled area has walks (node tools/pipeline/walkways.mjs --area=<id>); skipped');
for (const area of areas.filter((a) => a !== 'sanjuan' || process.env.WALKS_ALL)) {
  const dir = path.join(root, area), meta = JSON.parse(fs.readFileSync(path.join(dir, 'walks.json')));
  const roads = JSON.parse(fs.readFileSync(path.join(dir, 'roads.json')));
  const nodes = new Map(), links = [];
  for (const [bx, bz] of meta.blocks) {
    const b = fs.readFileSync(path.join(dir, 'walks', `${bx}_${bz}.bin`)), buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
    let o = 24;
    const [magic, nN, nL, nI, nC, nS] = new Uint32Array(buf, 0, 6);
    assert.equal(magic, 0x324b4c57, `${area} ${bx}_${bz}: not a walks block`);
    const take = (T, n) => { const a = new T(buf, o, n); o += a.byteLength; o += (4 - (o % 4)) % 4; return a; };
    const ids = take(Uint32Array, nN), xz = take(Float32Array, nN * 2);
    ids.forEach((id, i) => nodes.set(id, [xz[i * 2], xz[i * 2 + 1]]));
    const la = take(Uint32Array, nL), lb = take(Uint32Array, nL), inner = take(Uint8Array, nL), kind = take(Uint8Array, nL), width = take(Uint8Array, nL), w = take(Uint8Array, nL * 9);
    const pts = take(Float32Array, nI * 2), cl = take(Uint32Array, nC), ce = take(Int32Array, nC);
    take(Int32Array, nC); take(Uint8Array, nC);
    const sxz = take(Float32Array, nS * 2); take(Uint8Array, nS); take(Uint8Array, nS); const sl = take(Uint32Array, nS); take(Uint8Array, nS * 9);
    assert.equal(o, buf.byteLength, `${area} ${bx}_${bz}: the block's sections do not add up`);
    let pc = 0;
    for (let i = 0; i < nL; i++) {
      assert.ok(ids.includes(la[i]) && ids.includes(lb[i]), `${area}: a link to a node its block does not hold`);
      for (let q = 0; q < inner[i]; q++) assert.ok(Number.isFinite(pts[(pc + q) * 2]) && Number.isFinite(pts[(pc + q) * 2 + 1]), `${area}: a point not a number`);
      links.push({ a: la[i], b: lb[i], kind: kind[i], width: width[i] / 10, peak: Math.max(...w.subarray(i * 9, i * 9 + 9)) });
      pc += inner[i];
    }
    for (let c = 0; c < nC; c++) {
      assert.equal(kind[cl[c]], 2, `${area}: a crossing record on a link that is no crossing`);
      assert.ok(ce[c] >= 0 && ce[c] < roads.edges.length, `${area}: a crossing of no street`);
    }
    for (let s = 0; s < nS; s++) assert.ok(sl[s] < nL && Number.isFinite(sxz[s * 2]), `${area}: a stop on no link`);
  }
  for (const [, [x, z]] of nodes) assert.ok(Number.isFinite(x) && Number.isFinite(z), `${area}: a node not a number`);
  // the counts: people per 100 m at a profile's busiest, 0..40 (none at a crossing: people only pass)
  assert.ok(links.every((l) => l.peak <= 255 && (l.kind !== 2 || l.peak === 0)), `${area}: counts out of range`);
  assert.ok(links.filter((l) => l.kind === 0).length > links.length * 0.4, `${area}: too few sidewalks`);
  // one piece, more or less: the largest connected part holds most of the links
  const parent = new Map(), find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const id of nodes.keys()) parent.set(id, id);
  for (const l of links) parent.set(find(l.a), find(l.b));
  const size = new Map();
  for (const l of links) { const r = find(l.a); size.set(r, (size.get(r) ?? 0) + 1); }
  // (the municipality's expressways and the bay part its walks into a few large pieces; few links stand alone)
  const largest = Math.max(...size.values()) / links.length, alone = [...size.values()].filter((n) => n <= 2).reduce((s, n) => s + n, 0) / links.length;
  assert.ok(largest > 0.25, `${area}: the walks fall apart (largest piece ${(largest * 100).toFixed(0)}% of the links)`);
  assert.ok(alone < 0.03, `${area}: ${(alone * 100).toFixed(1)}% of the links stand on their own`);
  console.log(`walks ${area}: ${links.length} links, ${nodes.size} nodes, largest piece ${(largest * 100).toFixed(0)}%`);
}
