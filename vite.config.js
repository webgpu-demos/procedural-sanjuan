import { defineConfig } from 'vite';

export default defineConfig({
  base: './', // relative URLs: the built site works at any path (GitHub Pages serves it under /<repo>/)
  server: { port: 5280 },
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
