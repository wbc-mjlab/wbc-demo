# wbc-demo

Interactive in-browser demo for [wbc-mjlab](https://github.com/wbc-mjlab) WBC
(whole-body-control) policies. A static **Vite + TypeScript + Three.js** site
that shows a gallery of policies and a per-policy 3D viewport. Deploys to
**GitHub Pages**.

This repo is **data-driven**: the gallery is built from whatever policy folders
are committed under [`policies/`](policies/). Adding a policy is a content PR,
not a code change.

## Develop

```bash
npm install      # install deps (generates package-lock.json — commit it)
npm run dev      # start the Vite dev server (http://localhost:5173/wbc-demo/)
npm run build    # type-check (tsc) + production build into dist/
npm run preview  # serve the production build locally
```

Requires Node ≥ 20.19 (or ≥ 22.12), per Vite 8.

> The site is served under the `/wbc-demo/` base path (set in
> `vite.config.ts`) to match the GitHub Pages project URL, so the dev server
> URL includes that prefix.

## Adding a policy

1. Create `policies/<policy-id>/` with a `policy.yaml` manifest (+ artifacts:
   `policy.onnx`, `config.yaml`, clips, thumbnail).
2. Open a PR. On merge to `main`, CI builds and the gallery picks it up
   automatically — no code edits.

See [`policies/README.md`](policies/README.md) for the folder layout and the
(interim) manifest fields. The authoritative manifest schema is owned by issue
**wbc-mjlab-0d8**.

## Project layout

```
index.html / policy.html   # gallery + per-policy HTML entry points
vite.config.ts             # base: '/wbc-demo/'; multi-page build
src/
  main.ts                  # gallery: renders a card per discovered policy
  policy-page.ts           # per-policy view: mounts the Three.js viewport
  registry.ts              # build-time discovery of policies/*/policy.yaml
  types.ts                 # PolicyManifest (INTERIM — see wbc-mjlab-0d8)
  viewer/renderer.ts       # shared Three.js viewport + M2 live-engine mount point
  styles/tokens.css        # design tokens PLACEHOLDER (real palette: wbc-mjlab-cfd)
  styles/app.css           # application styles
policies/                  # one folder per policy (data source for the gallery)
public/                    # static assets copied verbatim into the build
.github/workflows/deploy.yml   # GitHub Pages build + deploy
```

## Roadmap (relative to this scaffold)

- **wbc-mjlab-cfd** — real design tokens / org palette → drop into `tokens.css`.
- **wbc-mjlab-0d8** — finalize the `policy.yaml` manifest schema.
- **wbc-mjlab-9as** — robot meshes (GLB); today the viewport shows a placeholder box.
- **wbc-mjlab-3ne** — playback rendering of recorded clips in the viewport.
- **M2** — live in-browser engine (mujoco-wasm + onnxruntime-web) at the
  `mountLiveEngine()` seam in `src/viewer/renderer.ts`.

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`, which builds the site
and publishes `dist/` to GitHub Pages. One-time setup: in the repo settings,
set **Settings → Pages → Source = GitHub Actions**.

Part of the [wbc-mjlab](https://github.com/wbc-mjlab) project.
