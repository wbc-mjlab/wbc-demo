/**
 * Spike entry point — load + step + render the Unitree G1 with mujoco-wasm.
 *
 * SPIKE ONLY — de-risking issue wbc-mjlab-x2t (physics + render, NO policy).
 * Proves the official `@mujoco/mujoco` (single-threaded) build can:
 *   1. load the G1 MJCF + 34 STL meshes into the Emscripten VFS,
 *   2. compile the model and step it under a trivial PD-hold controller,
 *   3. render it two ways — (A) drive the existing visual GLB per-body, and
 *      (B) MuJoCo's own geom renderer — for a side-by-side comparison.
 *
 * Perf and load results are mirrored onto `window.__spike` so a headless
 * Playwright run can read them out without scraping the DOM.
 */

import '../styles/app.css';
import '../styles/spike.css';
import {
  Box3,
  Vector3,
} from 'three';
import { Viewer } from '../viewer/renderer';
import { loadG1Sim, type MujocoSim } from './mujoco';
import { bindGlbToSim, type GlbBinding } from './bind-glb';
import { buildGeomRenderer, type GeomBinding } from './geom-renderer';
import { makePdHold, makeBaseHold } from './controller';

const BASE = import.meta.env.BASE_URL;
const MJCF_BASE = `${BASE}robots/g1/mjcf/`;
const GLB_URL = `${BASE}robots/g1/g1.meshopt.glb`;
const SCENE_XML = 'scene_g1.xml';

// The 34 STL basenames referenced by scene_g1.xml's <asset> block.
const MESH_FILES = [
  'pelvis.STL', 'pelvis_contour_link.STL',
  'left_hip_pitch_link.STL', 'left_hip_roll_link.STL', 'left_hip_yaw_link.STL',
  'left_knee_link.STL', 'left_ankle_pitch_link.STL', 'left_ankle_roll_link.STL',
  'right_hip_pitch_link.STL', 'right_hip_roll_link.STL', 'right_hip_yaw_link.STL',
  'right_knee_link.STL', 'right_ankle_pitch_link.STL', 'right_ankle_roll_link.STL',
  'waist_yaw_link_rev_1_0.STL', 'waist_roll_link_rev_1_0.STL', 'torso_link_rev_1_0.STL',
  'logo_link.STL', 'head_link.STL',
  'left_shoulder_pitch_link.STL', 'left_shoulder_roll_link.STL', 'left_shoulder_yaw_link.STL',
  'left_elbow_link.STL', 'left_wrist_roll_link.STL', 'left_wrist_pitch_link.STL',
  'left_wrist_yaw_link.STL', 'left_rubber_hand.STL',
  'right_shoulder_pitch_link.STL', 'right_shoulder_roll_link.STL', 'right_shoulder_yaw_link.STL',
  'right_elbow_link.STL', 'right_wrist_roll_link.STL', 'right_wrist_pitch_link.STL',
  'right_wrist_yaw_link.STL', 'right_rubber_hand.STL',
];

type RenderMode = 'glb' | 'geom';

interface SpikeStatus {
  ready: boolean;
  error: string | null;
  loadMs: number | null;
  nbody: number | null;
  nq: number | null;
  nv: number | null;
  nu: number | null;
  timestep: number | null;
  /** measured physics steps per wall-clock second */
  stepsPerSec: number | null;
  /** render frames per second */
  fps: number | null;
  /** stepsPerSec * timestep — 1.0 == real time */
  realtimeFactor: number | null;
  renderMode: RenderMode;
  unmatchedBodies: string[];
  geomCount: number | null;
  /** pelvis height (m) after settling — sanity check the robot didn't explode */
  pelvisHeight: number | null;
}

const status: SpikeStatus = {
  ready: false, error: null, loadMs: null,
  nbody: null, nq: null, nv: null, nu: null, timestep: null,
  stepsPerSec: null, fps: null, realtimeFactor: null,
  renderMode: 'glb', unmatchedBodies: [], geomCount: null, pelvisHeight: null,
};
// Expose for headless verification.
(window as unknown as { __spike: SpikeStatus }).__spike = status;

const ui = buildUi();

async function main(): Promise<void> {
  const t0 = performance.now();
  ui.setStatus('Loading MuJoCo WASM + G1 assets…');

  let sim: MujocoSim;
  try {
    sim = await loadG1Sim({
      baseUrl: MJCF_BASE,
      sceneXml: SCENE_XML,
      meshFiles: MESH_FILES,
      onProgress: (n, total) => ui.setStatus(`Fetching meshes ${n}/${total}…`),
    });
  } catch (err) {
    status.error = String(err);
    ui.setStatus(`LOAD FAILED: ${status.error}`, true);
    console.error(err);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__sim = sim; // diagnostics hook (spike only)
  status.loadMs = Math.round(performance.now() - t0);
  status.nbody = sim.nbody;
  status.nq = sim.nq;
  status.nv = sim.nv;
  status.nu = sim.nu;
  status.timestep = sim.timestep;

  // Build the shared Three.js viewport and drop the placeholder box.
  const viewer = new Viewer(ui.viewport);
  removePlaceholder(viewer);

  // Build BOTH render paths; show one at a time.
  const glb: GlbBinding = await bindGlbToSim({
    glbUrl: GLB_URL,
    sim,
    parent: viewer.robotRoot,
  });
  status.unmatchedBodies = glb.unmatchedBodies;

  const geom: GeomBinding = buildGeomRenderer({
    sim,
    parent: viewer.robotRoot,
    includeGroups: new Set([1, 2]), // visual meshes only
  });
  status.geomCount = geom.geomCount;

  // Default to GLB path; the other group is hidden.
  geom.root.visible = false;
  setMode('glb');

  function setMode(mode: RenderMode): void {
    status.renderMode = mode;
    glb.root.visible = mode === 'glb';
    geom.root.visible = mode === 'geom';
    ui.setMode(mode);
  }
  ui.onToggle(() => setMode(status.renderMode === 'glb' ? 'geom' : 'glb'));

  // Controller: PD-hold to default pose so the robot is actuated, not limp.
  const controller = makePdHold(sim, { kp: 80, kd: 4 });
  // Base-hold (default ON) pins the free base for a clean standing demo; toggle
  // OFF to watch the real free-base dynamics (robot falls under gravity).
  const baseHold = makeBaseHold(sim);
  let baseHeld = true;
  ui.onBaseToggle((held) => {
    baseHeld = held;
  });

  // ---- Step + render loop --------------------------------------------------
  // Step physics to keep up with wall-clock at the model's dt, capped so a slow
  // frame can't spiral. Measure steps/sec and fps over a rolling window.
  const dt = sim.timestep;
  let lastTime = performance.now();
  let acc = 0;
  let stepCounter = 0;
  let frameCounter = 0;
  let windowStart = performance.now();

  function frame(): void {
    const now = performance.now();
    let elapsed = (now - lastTime) / 1000;
    lastTime = now;
    if (elapsed > 0.1) elapsed = 0.1; // clamp huge gaps (tab switches)
    acc += elapsed;

    let stepsThisFrame = 0;
    const maxSteps = 40; // safety cap per rendered frame
    while (acc >= dt && stepsThisFrame < maxSteps) {
      controller.apply(sim);
      sim.mujoco.mj_step(sim.model, sim.data);
      if (baseHeld) baseHold.apply(sim);
      acc -= dt;
      stepsThisFrame += 1;
      stepCounter += 1;
    }

    // Push transforms to whichever renderer is visible (cheap to do both).
    glb.sync(sim);
    geom.sync(sim);

    frameCounter += 1;

    // Roll up perf once per second.
    if (now - windowStart >= 1000) {
      const secs = (now - windowStart) / 1000;
      status.stepsPerSec = Math.round(stepCounter / secs);
      status.fps = Math.round(frameCounter / secs);
      status.realtimeFactor = +(status.stepsPerSec * dt).toFixed(2);
      const pelvisId = sim.bodyNameToId.get('pelvis');
      if (pelvisId != null) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const xpos: any = sim.data.xpos;
        status.pelvisHeight = +(xpos[pelvisId * 3 + 2] as number).toFixed(3);
      }
      ui.updateMetrics(status);
      stepCounter = 0;
      frameCounter = 0;
      windowStart = now;
    }

    requestAnimationFrame(frame);
  }

  // Frame the robot once it's posed.
  glb.sync(sim);
  frameViewer(viewer, glb.root);

  status.ready = true;
  ui.setStatus('Running — PD hold to default pose.');
  ui.showMeta(status);
  requestAnimationFrame(frame);

  // A short uncapped benchmark: how fast can we step with NO rendering?
  void runStepBenchmark(sim);
}

/**
 * Headless-friendly raw-step benchmark: step as fast as possible for a fixed
 * count and record steps/sec. Mirrored onto window.__spike.benchStepsPerSec.
 */
async function runStepBenchmark(sim: MujocoSim): Promise<void> {
  // Let the page settle first.
  await new Promise((r) => setTimeout(r, 1500));
  const controller = makePdHold(sim, { kp: 80, kd: 4 });
  const N = 5000;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    controller.apply(sim);
    sim.mujoco.mj_step(sim.model, sim.data);
  }
  const ms = performance.now() - t0;
  const sps = Math.round((N / ms) * 1000);
  (window as unknown as { __spike: SpikeStatus & { benchStepsPerSec?: number; benchRealtime?: number } }).__spike.benchStepsPerSec = sps;
  (window as unknown as { __spike: { benchRealtime?: number } }).__spike.benchRealtime = +(sps * sim.timestep).toFixed(2);
  console.info(`[spike] raw step benchmark: ${sps} steps/s (${(sps * sim.timestep).toFixed(1)}x realtime), ${N} steps in ${ms.toFixed(0)}ms`);
}

function removePlaceholder(viewer: Viewer): void {
  const ph = viewer.robotRoot.getObjectByName('placeholder-robot');
  if (ph) viewer.robotRoot.remove(ph);
}

function frameViewer(viewer: Viewer, target: import('three').Object3D): void {
  const box = new Box3().setFromObject(target);
  if (box.isEmpty()) return;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  const radius = Math.max(size.x, size.y, size.z) || 1;
  viewer.controls.target.copy(center);
  viewer.camera.position.copy(center).add(new Vector3(radius * 1.2, radius * 0.6, radius * 1.6));
  viewer.camera.near = radius / 100;
  viewer.camera.far = radius * 100;
  viewer.camera.updateProjectionMatrix();
}

// ---- Minimal UI chrome (kept tiny; the report is the real deliverable) ------
function buildUi() {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('#app missing');
  root.innerHTML = `
    <div class="spike">
      <header class="spike__bar">
        <strong>G1 · mujoco-wasm spike</strong>
        <span class="spike__status" id="spk-status">booting…</span>
        <button id="spk-base" class="spike__btn">base: held</button>
        <button id="spk-toggle" class="spike__btn">render: GLB</button>
      </header>
      <div class="spike__viewport" id="spk-viewport"></div>
      <footer class="spike__metrics" id="spk-metrics"></footer>
    </div>`;
  const viewport = root.querySelector<HTMLElement>('#spk-viewport')!;
  const statusEl = root.querySelector<HTMLElement>('#spk-status')!;
  const metricsEl = root.querySelector<HTMLElement>('#spk-metrics')!;
  const toggleEl = root.querySelector<HTMLButtonElement>('#spk-toggle')!;
  const baseEl = root.querySelector<HTMLButtonElement>('#spk-base')!;
  return {
    viewport,
    setStatus(s: string, err = false) {
      statusEl.textContent = s;
      statusEl.style.color = err ? '#ff6b6b' : '';
    },
    setMode(mode: RenderMode) {
      toggleEl.textContent = `render: ${mode.toUpperCase()}`;
    },
    onToggle(fn: () => void) {
      toggleEl.addEventListener('click', fn);
    },
    onBaseToggle(fn: (held: boolean) => void) {
      let held = true;
      baseEl.addEventListener('click', () => {
        held = !held;
        baseEl.textContent = `base: ${held ? 'held' : 'free'}`;
        fn(held);
      });
    },
    showMeta(s: SpikeStatus) {
      this.updateMetrics(s);
    },
    updateMetrics(s: SpikeStatus) {
      metricsEl.innerHTML = [
        kv('load', s.loadMs != null ? `${s.loadMs} ms` : '…'),
        kv('nbody', s.nbody),
        kv('nq/nv/nu', `${s.nq}/${s.nv}/${s.nu}`),
        kv('dt', s.timestep != null ? `${(s.timestep * 1000).toFixed(1)} ms` : '…'),
        kv('steps/s', s.stepsPerSec ?? '…'),
        kv('fps', s.fps ?? '…'),
        kv('realtime', s.realtimeFactor != null ? `${s.realtimeFactor}×` : '…'),
        kv('pelvis z', s.pelvisHeight != null ? `${s.pelvisHeight} m` : '…'),
        kv('geoms', s.geomCount ?? '…'),
      ].join('');
    },
  };
}

function kv(k: string, v: unknown): string {
  return `<span class="spike__kv"><em>${k}</em>${v}</span>`;
}

void main();
