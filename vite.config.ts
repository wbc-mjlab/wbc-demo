import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Project lives at https://<org>.github.io/wbc-demo/ on GitHub Pages, so every
// emitted asset URL must be prefixed with the repo name. This MUST stay in sync
// with the repo name; the deploy workflow relies on it.
const BASE = '/wbc-demo/';

export default defineConfig({
  base: BASE,
  build: {
    // Multi-page app: the gallery (index.html) and the per-policy view
    // (policy.html) are separate HTML entry points. Three.js code-splits per
    // page so the gallery stays light.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        policy: resolve(__dirname, 'policy.html'),
      },
    },
  },
});
