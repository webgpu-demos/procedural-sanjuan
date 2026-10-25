// What stands in the roadway, across an area's compiled tiles: on the paved carriageway (more than a kerb's width
// in), or within reach of a car in a road's outer lane. The client leaves both out as it loads a tile
// (src/shared/roadway.js; signal masts step back along their approach instead). node tools/audit/roadway.mjs [area]
import fs from 'node:fs';
import path from 'node:path';
import { decodeTile, PROP } from '../../src/shared/tileformat.js';
import { clearRoadway, laneDepth, clearLanes } from '../../src/shared/roadway.js';

const area = process.argv[2] ?? 'sanjuan', dir = path.join('public/tiles', area);
const NAME = Object.fromEntries(Object.entries(PROP).map(([k, v]) => [v, k]));
const depth = laneDepth(JSON.parse(fs.readFileSync(path.join(dir, 'roads.json'), 'utf8')));
const files = fs.readdirSync(dir).filter((f) => /^t_-?\d+_-?\d+\.bin$/.test(f));
const paved = {}, lanes = {}, total = {}, deepest = [];
let moved = 0;
for (const f of files) {
  const buf = fs.readFileSync(path.join(dir, f)), tile = decodeTile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  for (const p of tile.props) total[NAME[p.kind]] = (total[NAME[p.kind]] ?? 0) + 1;
  const out = [], kept = clearRoadway(tile, out);
  for (const p of out) paved[NAME[p.kind]] = (paved[NAME[p.kind]] ?? 0) + 1;
  const flat = Float32Array.from(kept.props.flatMap((p) => [p.kind, p.variant, p.rot, p.x, p.z, p.scale]));
  const res = clearLanes(flat, kept.wires, depth);
  for (const [k, x, z, d] of res.gone) { lanes[NAME[k]] = (lanes[NAME[k]] ?? 0) + 1; deepest.push([f, NAME[k], x.toFixed(1), z.toFixed(1), d.toFixed(1)].join(' ')); }
  for (let i = 0; i < res.props.length; i += 6) if (res.props[i] === PROP.SIGNAL && !flat.some((v, j) => j % 6 === 3 && v === res.props[i + 3])) moved++;
}
console.log(`${files.length} tiles`);
console.log('on the paved carriageway, left out:', paved);
console.log('in a lane\'s reach, left out:', lanes, `(signal masts stepped back: ${moved})`);
console.log('of:', total);
console.log('deepest in a lane:', deepest.sort((a, b) => +b.split(' ')[4] - +a.split(' ')[4]).slice(0, 6));
