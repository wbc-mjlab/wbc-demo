import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Project lives at https://<org>.github.io/wbc-demo/ on GitHub Pages, so every
// emitted asset URL must be prefixed with the repo name. This MUST stay in sync
// with the repo name; the deploy workflow relies on it.
const BASE = '/wbc-demo/';

// The committed dev policy bundle (issue wbc-mjlab-l0a) lives at repo
// `policies/g1-samples/` — the single source of truth. Rather than duplicate
// its ~6.5 MB into `public/`, serve `policies/` at `/policies/` directly:
//  • dev + preview: a middleware streams files straight from the repo dir;
//  • build: copy it into the output so the deployed Pages site works too.
// This keeps the bundle versioned in one place and avoids drift.
function servePolicies(): Plugin {
  const dir = resolve(__dirname, 'policies');
  const mount = '/policies/';
  return {
    name: 'wbc-serve-policies',
    configureServer(server) {
      server.middlewares.use(mount, (req, res, next) => {
        serveFromDir(dir, req.url ?? '', res, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(BASE + 'policies/', (req, res, next) => {
        serveFromDir(dir, req.url ?? '', res, next);
      });
    },
    closeBundle() {
      const out = resolve(__dirname, 'dist', 'policies');
      if (existsSync(dir)) cpSync(dir, out, { recursive: true });
    },
  };
}

// Minimal static file streamer for the policy middleware (dev/preview only).
function serveFromDir(
  dir: string,
  url: string,
  res: import('node:http').ServerResponse,
  next: () => void,
): void {
  const rel = decodeURIComponent((url.split('?')[0] ?? '')).replace(/^\/+/, '');
  const file = resolve(dir, rel);
  if (!file.startsWith(dir) || !existsSync(file)) {
    next();
    return;
  }
  const types: Record<string, string> = {
    '.onnx': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.json': 'application/json',
    '.yaml': 'text/yaml',
    '.png': 'image/png',
  };
  const ext = file.slice(file.lastIndexOf('.'));
  res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  import('node:fs').then(({ createReadStream }) => createReadStream(file).pipe(res));
}

export default defineConfig({
  base: BASE,
  plugins: [servePolicies()],
  // onnxruntime-web ships prebuilt wasm; let Vite leave it alone.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    // Multi-page app: live demo (index.html), tracking-only page, clip gallery,
    // and legacy deep links (policy.html). Three.js code-splits per page so
    // the gallery stays light.
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        tracking: resolve(__dirname, 'tracking.html'),
        gallery: resolve(__dirname, 'gallery.html'),
        policy: resolve(__dirname, 'policy.html'),
      },
    },
  },
});
