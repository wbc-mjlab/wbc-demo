# wbc-demo

**▶ Live demo: https://wbc-mjlab.github.io/wbc-demo/**

An interactive, in-browser showcase for [wbc-mjlab](https://github.com/wbc-mjlab)
whole-body-control (WBC) policies. Every motion clip runs **live in the browser** —
a real MuJoCo physics sim ([`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco)
WASM) stepped by the policy network ([onnxruntime-web](https://onnxruntime.ai/docs/get-started/with-javascript/web.html)),
not a pre-rendered video. Built with **Vite + TypeScript + Three.js**, deployed as a
static site to **GitHub Pages**.

- **Gallery** — a wall of cards, each a motion clip tracked live in its own sim.
  Scroll to bring more to life; click one to open **tracking** mode on that clip.
- **Live / Gen demo** (`/`) — full-screen viewport. **Generator starts on by
  default** when Gen assets are present (W/S move, Q/E strafe, A/D turn, Shift
  sprint, Space crouch). **Compact HUD** is the default (trajectory dropdown +
  essentials); use **full UI** or `?chrome=full` for the dense bar. On touch,
  enable the on-screen stick with **pad**. Press **G** (or **clips**) for
  in-page clip tracking, or open the dedicated tracking URL. Same Arc→WBC path as
  [wbc-g1-deploy](https://github.com/wbc-mjlab/wbc-g1-deploy)
  `wbc_reference_node` Gen mode (`policies/<id>/gen/params/`).
- **Tracking page** (`/tracking.html`) — shareable **reference / clip tracking**
  only (Generator off). Same query params: `?id=<policy>&clip=<clip>`.
  Force HUD chrome with `?chrome=minimal` or `?chrome=full`. Toggle the on-screen
  stick with the **pad** button (or `?pad=on` / `?pad=off`; preference is saved).
  On phones/tablets the demo starts in **tracking** with the HUD **hidden**
  (`H` to show); override with `?mode=gen|tracking` and `?hud=on|off`.
  The controls help panel switches with Gen vs tracking mode.
- **Deploy-aligned clip UX** — browsable clips come from
  `policies/<id>/reference/manifest.yaml` (same idea as
  [wbc-g1-deploy](https://github.com/wbc-mjlab/wbc-g1-deploy) `config/clips/manifest.yaml`).
  Get-up / lie-down are **pose clips** gated by an in-tracking FSM (only when down/up
  and idle), matching deploy `Wbc_Tracking` behavior.
- **No special headers** — inference runs on the single-threaded SIMD WASM backend
  (`numThreads = 1`), so there's **no SharedArrayBuffer / COOP-COEP requirement** —
  it deploys on plain GitHub Pages.

## Quick start

```bash
npm install      # install deps
npm run dev      # Vite dev server → http://localhost:5173/wbc-demo/
npm run build    # type-check (tsc) + production build into dist/
npm run preview  # serve the production build locally
npm run validate # validate every policies/*/policy.yaml against the schema
```

Requires Node ≥ 20.19 (or ≥ 22.12), per Vite 8. The site is served under the
`/wbc-demo/` base path (set in `vite.config.ts`) to match the GitHub Pages project
URL — that prefix is part of the dev URL too.

## How it works

Each control step (50 Hz), the engine ([`src/engine/live-engine.ts`](src/engine/live-engine.ts)):

1. reads the current frame of the clip's **reference command** (a compact 39-dim
   stream — see [`REFERENCE_STREAM.md`](REFERENCE_STREAM.md));
2. assembles the full actor observation by concatenating that reference with live
   proprioception from its own MuJoCo sim;
3. runs `policy.onnx` → joint actions;
4. maps actions to PD torques (`reference_residual` + `kp/kd`) and substeps physics.

This pipeline is ported from the `wbc-g1-deploy` C++ runtime, so the browser tracks
the same motions the real robot does. The gallery shares a small **pool of engines**
across all cards — an engine is created lazily, then reassigned to whichever cards
are on-screen (swapping only the cheap per-clip stream), keeping live WebGL contexts
and CPU bounded no matter how many clips are shown.

## Adding a policy

1. Create `policies/<policy-id>/` with a `policy.yaml` manifest plus its artifacts:
   `policy.onnx`, `config.yaml`, a `reference/` clip stream, and a thumbnail.
2. Run `npm run validate` to check the manifest against the schema.
3. Open a PR. On merge to `main`, CI builds and the gallery picks it up — no code edits.

The end-to-end path (train + export → drop folder → validate → PR) is in
[`CONTRIBUTING.md`](CONTRIBUTING.md). The folder layout and full manifest field
reference are in [`policies/README.md`](policies/README.md); the contract is defined
by [`policies/policy.schema.json`](policies/policy.schema.json) and mirrored by
`PolicyManifest` in [`src/types.ts`](src/types.ts).

## Project layout

```
index.html / policy.html / tracking.html
                           # live Gen demo, legacy deep links, tracking-only page
gallery.html               # clip wall
vite.config.ts             # base '/wbc-demo/'; serves policies/ in dev; multi-page build
src/
  gallery.ts               # gallery: a live card per clip, shared engine pool
  live-demo.ts             # shared HUD: chrome modes, teleop, virtual stick
  policy-page.ts           # boots live-demo in Gen mode
  tracking-page.ts         # boots live-demo in tracking / reference mode
  registry.ts              # build-time discovery + schema validation of policies
  validate-manifest.ts     # shared Ajv validator (registry + CI script)
  types.ts                 # PolicyManifest contract
  engine/                  # the live engine
    live-engine.ts         #   create/control loop: sim + policy + render, DOM-free
    mujoco.ts              #   load + step the MuJoCo WASM model
    policy-runner.ts       #   onnxruntime-web inference
    policy-config.ts       #   config.yaml + reference-stream loaders
    wbc-controller.ts      #   obs assembly + reference_residual action + PD torque
    geom-renderer.ts       #   Three.js meshes driven from MuJoCo geom transforms
  viewer/renderer.ts       # shared Three.js viewport (camera/lights/grid/controls)
  styles/                  # tokens.css (org palette) + app.css + live.css (HUD)
scripts/validate.ts        # `npm run validate` — manifest gate (also run in CI)
policies/                  # one folder per policy (the gallery's data source)
public/robots/g1/          # G1 MJCF + meshes (GLB) served to the engine
.github/workflows/deploy.yml   # GitHub Pages build + deploy
```

## Deployment

Pushes to `main` trigger [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml),
which builds the site and publishes `dist/` to GitHub Pages. One-time setup:
**Settings → Pages → Source = GitHub Actions**.

---

Part of the [wbc-mjlab](https://github.com/wbc-mjlab) project.
