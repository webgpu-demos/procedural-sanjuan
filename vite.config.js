import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// ez-tree from its source, with its textures cut down to the three the trees use (src/vendor/eztree-textures.js): its
// build inlines all twenty, about 4 MB of the page
const ezTree = {
  name: 'ez-tree-textures',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === '@dgreenheck/ez-tree') return here('./node_modules/@dgreenheck/ez-tree/src/lib/index.js');
    if (source === './textures' && importer?.replace(/\\/g, '/').includes('/@dgreenheck/ez-tree/src/lib/')) return here('./src/vendor/eztree-textures.js');
    return null;
  },
};

export default defineConfig({
  base: './', // relative URLs: the built site works at any path (GitHub Pages serves it under /<repo>/)
  server: { port: 5280 },
  build: { target: 'es2022' },
  worker: { format: 'es' },
  plugins: [ezTree],
  optimizeDeps: { exclude: ['@dgreenheck/ez-tree'] }, // (served from source in development too, through the plugin)
});
