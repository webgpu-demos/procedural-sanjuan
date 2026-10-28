// The crowd's avatars as the client loads them (public/models/people/crowd/, src/world/people.js), from what
// crowd.py made (an avatar's GLB with its clips, its atlas, its .json):
//   <id>.glb      its three levels of detail on its skeleton, compressed (gltfpack: meshopt), no clips
//   <id>.webp     its atlas (the skin marked in alpha)
//   <sex>-move.glb, <sex>-still.glb   the clips (crowd.py retargets them as the bones turn in the world, so every
//                 avatar of the library's women, and of its men, gets the very same rotations; only the lengths of
//                 the bones differ, which each avatar's own skeleton has): the walks at 30 frames a second, the rest at 10
//   people.json   the avatars, who they are (ROLES), their skeleton, their skin's colour
// Usage: node tools/assets/crowd_pack.mjs <crowd.py output dir> [out dir]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const SRC = process.argv[2], OUT = process.argv[3] ?? path.resolve(import.meta.dirname, '../../public/models/people/crowd');
const GLTFPACK = process.env.GLTFPACK ?? 'gltfpack';
// who each is in a San Juan street: everyday (the most), office (the Milla de Oro, the government), clinic (the
// Centro Médico, the clinics), security (at a bank's or a mall's door), work (a site, a delivery), running (the
// promenades at dawn and dusk), beach (on the sand and the street behind it), child (with a grown-up)
const ROLES = {
  m01: 'everyday',
  f01: 'everyday', f02: 'everyday', f03: 'everyday', f05: 'everyday office', f08: 'everyday', f13: 'everyday', f17: 'everyday', fp2: 'everyday',
  m06: 'everyday', m07: 'everyday office', m08: 'everyday office', m09: 'everyday', m11: 'everyday', m12: 'everyday', m14: 'everyday', m16: 'everyday', wm1: 'everyday work',
  bf1: 'office', bf2: 'office', bf4: 'office', bm2: 'office', bm5: 'office', bm6: 'office', bm7: 'office everyday',
  nf1: 'clinic', df2: 'clinic', nm1: 'clinic', dm3: 'clinic', sm1: 'security', cm4: 'work', cm7: 'work',
  jf2: 'running', jm4: 'running', bchf: 'beach', bchm: 'beach', kf1: 'child', km1: 'child', km2: 'child',
};
// (whose skin can take another tone: those whose skin the atlas marks cleanly; checked by eye)
const NO_TINT = new Set(process.env.NO_TINT?.split(',') ?? []);
// How often each is picked among those of its role, by what it wears for the heat: short sleeves, a tank top, a
// dress, shorts 1; long sleeves rolled or light 0.5; a sweater, a jacket, a blazer out of the office 0.15
const WEIGHT = { f02: 0.15, f05: 0.4, m06: 0.4, m07: 0.25, m08: 0.6, m12: 0.2, m14: 0.5, wm1: 0.5, km1: 0.3, kf1: 0.7, m01: 1.2, km2: 1.2 };
// fair or red hair: a darker skin under it reads as a dye job on every head, so their tone stays nearer their own
const FAIR_HAIR = new Set(['f01', 'f13', 'f17', 'm16', 'kf1', 'bf2', 'dm3', 'jf2', 'bchf', 'm08', 'km1']);

const readGlb = (file) => {
  const b = fs.readFileSync(file), len = b.readUInt32LE(12);
  return { json: JSON.parse(b.subarray(20, 20 + len).toString()), bin: b.subarray(20 + len + 8, 20 + len + 8 + b.readUInt32LE(20 + len)) };
};
const writeGlb = (file, json, bin) => {
  const j = Buffer.from(JSON.stringify(json)), jp = Buffer.alloc((4 - (j.length % 4)) % 4, 0x20), bp = Buffer.alloc((4 - (bin.length % 4)) % 4);
  const jl = j.length + jp.length, bl = bin.length + bp.length, h = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
  h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + jl + 8 + bl, 8);
  jh.writeUInt32LE(jl, 0); jh.writeUInt32LE(0x4e4f534a, 4); bh.writeUInt32LE(bl, 0); bh.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([h, jh, j, jp, bh, bin, bp]));
};
const pack = (input, output, args) => execFileSync(GLTFPACK, ['-i', input, '-o', output, '-c', '-kn', '-km', ...args], { stdio: 'pipe' });
fs.mkdirSync(OUT, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crowd-'));
const MOVE = new Set(['walk', 'walk2', 'stroll', 'brisk', 'jog']);
const groups = new Map(), avatars = [];
for (const id of Object.keys(ROLES)) {
  const file = path.join(SRC, `${id}.glb`);
  if (!fs.existsSync(file)) { console.warn('missing', id); continue; }
  const info = JSON.parse(fs.readFileSync(path.join(SRC, `${id}.json`)));
  const glb = readGlb(file), sex = info.sex;
  if (!groups.has(sex)) groups.set(sex, { id: sex, rep: id, members: [] });
  const g = groups.get(sex); g.members.push(id);
  // the avatar without its clips
  const json = structuredClone(glb.json); delete json.animations;
  const bare = path.join(tmp, `${id}.glb`); writeGlb(bare, json, glb.bin);
  pack(bare, path.join(OUT, `${id}.glb`), ['-vpf', '-vtf', '-kv']); // (-kv: the UVs, which no material here maps; -vpf -vtf: plain floats, no dequantizing transforms for the client to apply)
  fs.copyFileSync(path.join(SRC, `${id}.webp`), path.join(OUT, `${id}.webp`));
  avatars.push({ id, source: info.source, sex: info.sex, roles: ROLES[id].split(' '), group: g.id, skin: info.skin, tint: !NO_TINT.has(id), fairHair: FAIR_HAIR.has(id), weight: WEIGHT[id] ?? 1, triangles: info.triangles });
  console.log(id, g.id, fs.statSync(path.join(OUT, `${id}.glb`)).size, fs.statSync(path.join(OUT, `${id}.webp`)).size);
}
// each sex's clips: its first avatar's, without its meshes
for (const g of groups.values()) {
  const glb = readGlb(path.join(SRC, `${g.rep}.glb`));
  for (const [part, keep, hz] of [['move', (n) => MOVE.has(n), 30], ['still', (n) => !MOVE.has(n), 10]]) {
    const json = structuredClone(glb.json);
    json.animations = json.animations.filter((a) => keep(a.name));
    for (const n of json.nodes) { delete n.mesh; delete n.skin; }
    delete json.meshes; delete json.skins; delete json.materials;
    const f = path.join(tmp, `${g.id}-${part}.glb`); writeGlb(f, json, glb.bin);
    pack(f, path.join(OUT, `${g.id}-${part}.glb`), ['-af', String(hz), '-ar', '14']);
    console.log(g.id, part, g.members.join(' '), fs.statSync(path.join(OUT, `${g.id}-${part}.glb`)).size);
  }
}
fs.writeFileSync(path.join(OUT, 'people.json'), JSON.stringify({
  version: 1, groups: [...groups.values()].map((g) => ({ id: g.id, move: `${g.id}-move.glb`, still: `${g.id}-still.glb`, members: g.members })), avatars,
}, null, 1));
fs.rmSync(tmp, { recursive: true, force: true });
