// ez-tree's textures.js, cut down to what this city draws (vite.config.js puts it in place of the package's own). The
// package's build inlines all twenty of its bark and leaf maps (4 MB of the page's 5.5) and loads every one when it is
// imported; the trees here (src/world/props.js TREES: Ash Medium and three oaks) take only the oak bark's colour and
// the ash and oak leaves, into materials of their own. Any other map asked for is the oak's colour, or none.
import * as THREE from 'three';
import oakColor from '../../node_modules/@dgreenheck/ez-tree/src/lib/assets/bark/oak_color_1k.jpg';
import ashLeaves from '../../node_modules/@dgreenheck/ez-tree/src/lib/assets/leaves/ash_color.png';
import oakLeaves from '../../node_modules/@dgreenheck/ez-tree/src/lib/assets/leaves/oak_color.png';

const loader = new THREE.TextureLoader();
const cache = new Map();
const load = (url) => {
  if (!cache.has(url)) {
    const t = loader.load(url);
    t.premultiplyAlpha = true;
    t.colorSpace = THREE.SRGBColorSpace;
    cache.set(url, t);
  }
  return cache.get(url);
};

export function getBarkTexture(barkType, fileType, scale = { x: 1, y: 1 }) {
  if (fileType !== 'color') return null;
  const texture = load(oakColor);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.x = scale.x;
  texture.repeat.y = 1 / scale.y;
  return texture;
}

export function getLeafTexture(leafType) {
  return load(leafType === 'ash' ? ashLeaves : oakLeaves);
}
