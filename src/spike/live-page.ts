/**
 * Live engine entry point — the tracer-bullet milestone (wbc-mjlab-uxq).
 *
 * Closes the loop: mujoco-wasm physics + onnxruntime-web inference + the exact
 * deploy obs/action/PD pipeline, driving the G1 to track a motion clip live in
 * the browser. Builds directly on the spike's load/step/render (mujoco.ts,
 * geom-renderer.ts) and adds the policy runner (policy-runner.ts), config +
 * reference loaders (policy-config.ts), and the WBC controller (wbc-controller.ts).
 *
 *   ┌─ reference stream (.bin, 50 Hz) ─┐
 *   │                                  ▼
 *   sim proprio ──► assemble 132-dim obs ──► policy.onnx ──► 29 actions
 *                                                              │
 *                              reference_residual + PD→torque ◄┘
 *                                       │
 *                                  data.ctrl ──► mj_step ×4 ──► render (geom)
 *
 * Physics timing pinned to training: timestep 0.005 s, decimation 4 → 50 Hz
 * control, integrator implicitfast, iterations 10 / ls_iterations 20
 * (see wbc-mjlab `wbc_env_cfg.py` SimulationCfg/MujocoCfg).
 *
 * Diagnostics mirrored onto `window.__live` for headless Playwright checks.
 */

import '../styles/app.css';
import '../styles/live.css';
import { Box3, Vector3 } from 'three';
import { Viewer } from '../viewer/renderer';
import { loadG1Sim, type MujocoSim } from './mujoco';
import { buildGeomRenderer, type GeomBinding } from './geom-renderer';
import {
  loadPolicyConfig,
  loadReferenceIndex,
  loadReferenceStream,
  type PolicyConfig,
  type ReferenceClip,
  type ReferenceIndex,
  type ReferenceStream,
} from './policy-config';
import { loadPolicy, type PolicyRunner } from './policy-runner';
import { makeWbcController } from './wbc-controller';

const BASE = import.meta.env.BASE_URL;
const MJCF_BASE = `${BASE}robots/g1/mjcf/`;
const POLICY_BASE = `${BASE}policies/g1-samples/`;
const SCENE_XML = 'scene_g1.xml';

// Training-parity physics timing (wbc-mjlab SimulationCfg / MujocoCfg).
const PHYS_TIMESTEP = 0.005; // s
const SOLVER_ITER = 10;
const SOLVER_LS_ITER = 20;
const INTEGRATOR = 'implicitfast';

// The 34 STL basenames referenced by scene_g1.xml (same set as the spike).
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

interface LiveStatus {
  ready: boolean;
  error: string | null;
  loadMs: number | null;
  obsDim: number | null; // assembled obs length
  modelObsDim: number | null; // ONNX input length
  actionDim: number | null;
  decimation: number | null;
  controlHz: number | null; // measured policy steps/sec
  fps: number | null; // render frames/sec
  realtime: number | null; // controlHz * policyStepDt
  clipId: string | null;
  clipFrame: number | null;
  clipFrames: number | null;
  pelvisHeight: number | null;
  upright: number | null; // projected-gravity Z; -1 == perfectly upright
  fell: boolean; // pelvis below a threshold for a while
  playing: boolean;
  inferMs: number | null; // mean policy inference time (ms)
}

const status: LiveStatus = {
  ready: false, error: null, loadMs: null,
  obsDim: null, modelObsDim: null, actionDim: null,
  decimation: null, controlHz: null, fps: null, realtime: null,
  clipId: null, clipFrame: null, clipFrames: null,
  pelvisHeight: null, upright: null, fell: false, playing: true, inferMs: null,
};
(window as unknown as { __live: LiveStatus }).__live = status;

const ui = buildUi();

async function main(): Promise<void> {
  const t0 = performance.now();
  ui.setStatus('Loading config + reference index…');

  // 1) Config + reference index (small JSON/YAML) first, so we can size things.
  let cfg: PolicyConfig;
  let refIndex: ReferenceIndex;
  try {
    [cfg, refIndex] = await Promise.all([
      loadPolicyConfig(`${POLICY_BASE}config.yaml`),
      loadReferenceIndex(`${POLICY_BASE}reference/index.json`),
    ]);
  } catch (err) {
    return fail(`config/index load failed: ${String(err)}`);
  }
  status.obsDim = cfg.obsDim;
  status.decimation = Math.round(cfg.policyStepDt / PHYS_TIMESTEP);

  // 2) MuJoCo sim (pin physics timing for training parity), policy, GLB.
  ui.setStatus('Loading MuJoCo WASM + G1 + policy…');
  let sim: MujocoSim;
  let policy: PolicyRunner;
  try {
    [sim, policy] = await Promise.all([
      loadG1Sim({
        baseUrl: MJCF_BASE,
        sceneXml: SCENE_XML,
        meshFiles: MESH_FILES,
        xmlTransform: pinPhysicsOption,
        onProgress: (n, total) => ui.setStatus(`Fetching meshes ${n}/${total}…`),
      }),
      loadPolicy({
        url: `${POLICY_BASE}policy.onnx`,
        expectedObsDim: cfg.obsDim,
        expectedActionDim: cfg.jointNames.length,
      }),
    ]);
  } catch (err) {
    return fail(`engine load failed: ${String(err)}`);
  }
  status.modelObsDim = policy.obsDim;
  status.actionDim = policy.actionDim;
  status.loadMs = Math.round(performance.now() - t0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__sim = sim;

  // Parity guard: assembled obs vs model input.
  if (cfg.obsDim !== policy.obsDim) {
    return fail(
      `obs dim mismatch: assembled ${cfg.obsDim} vs model ${policy.obsDim}`,
    );
  }
  console.info(
    `[live] obs dim ${cfg.obsDim} (model ${policy.obsDim}), action ${policy.actionDim}, ` +
      `decimation ${status.decimation} @ ${(1 / cfg.policyStepDt).toFixed(0)} Hz`,
  );

  // 3) Viewer + geom render path: build Three meshes straight from the compiled
  // MuJoCo geoms (visual groups 1/2) and drive them from data.geom_xpos/xmat.
  // Reads crisper than the baked GLB and needs no separate mesh asset.
  const viewer = new Viewer(ui.viewport);
  const ph = viewer.robotRoot.getObjectByName('placeholder-robot');
  if (ph) viewer.robotRoot.remove(ph);
  const robot: GeomBinding = buildGeomRenderer({
    sim,
    parent: viewer.robotRoot,
    includeGroups: new Set([1, 2]),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__viewer = viewer; // diagnostics / headless framing hook

  // 4) Controller.
  const controller = makeWbcController({ sim, cfg, policy });

  // 5) Clip state — default to the walk clip.
  let stream: ReferenceStream;
  let clip: ReferenceClip;
  let clipFrame = 0;
  let fellFrames = 0; // consecutive metric windows with the pelvis below threshold

  async function selectClip(id: string): Promise<void> {
    const c = refIndex.clips.find((x) => x.id === id) ?? refIndex.clips[0];
    if (!c) throw new Error('reference index has no clips');
    ui.setStatus(`Loading clip ${c.name}…`);
    stream = await loadReferenceStream(`${POLICY_BASE}reference/${c.file}`, refIndex.commandDim);
    clip = c;
    status.clipId = c.id;
    status.clipFrames = stream.frames;
    resetToStart();
    ui.setStatus(`Tracking “${c.name}” (${stream.frames} frames)`);
  }

  function resetToStart(): void {
    clipFrame = 0;
    controller.resetToReference(stream.frame(0));
    robot.sync(sim);
    status.fell = false;
    fellFrames = 0;
  }

  const walk = refIndex.clips.find((c) => c.id === 'walk1_subject1') ?? refIndex.clips[0];
  if (!walk) return fail('reference index has no clips');
  await selectClip(walk.id);
  ui.populateClips(refIndex.clips, walk.id, (id) => void selectClip(id));
  frameViewer(viewer, robot.root);

  // ---- Control + render loop ----------------------------------------------
  // Drive the reference stream + policy at exactly cfg.policyStepDt (50 Hz),
  // substepping the physics `decimation` times per control step at PHYS_TIMESTEP.
  const policyDt = cfg.policyStepDt;
  const decimation = status.decimation!;
  let last = performance.now();
  let acc = 0;
  let ctrlCount = 0;
  let frameCount = 0;
  let windowStart = performance.now();
  let inferAccum = 0;
  let inferCount = 0;
  let stepping = false; // guard against overlapping async control steps

  async function controlStep(): Promise<void> {
    const tI = performance.now();
    await controller.step(stream.frame(clipFrame));
    inferAccum += performance.now() - tI;
    inferCount += 1;
    // Substep physics, re-applying the held torque each substep.
    for (let s = 0; s < decimation; s++) {
      controller.applyTorque();
      sim.mujoco.mj_step(sim.model, sim.data);
    }
    ctrlCount += 1;
    if (status.playing) {
      clipFrame += 1;
      if (clipFrame >= stream.frames) clipFrame = 0; // loop
    }
  }

  function frame(): void {
    const now = performance.now();
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.1) elapsed = 0.1; // clamp tab-switch gaps
    acc += elapsed;

    // Fire control steps to keep up with wall-clock, but never overlap the async
    // inference (single in-flight). Cap to avoid spiral after a stall.
    if (!stepping && acc >= policyDt) {
      stepping = true;
      void (async () => {
        let budget = 4; // max control steps caught up per rendered frame
        while (acc >= policyDt && budget-- > 0) {
          await controlStep();
          acc -= policyDt;
        }
        stepping = false;
      })();
    }

    robot.sync(sim);
    followRobot();
    frameCount += 1;

    // Roll up metrics once a second.
    if (now - windowStart >= 1000) {
      const secs = (now - windowStart) / 1000;
      status.controlHz = Math.round(ctrlCount / secs);
      status.fps = Math.round(frameCount / secs);
      status.realtime = +(status.controlHz * policyDt).toFixed(2);
      status.inferMs = inferCount ? +(inferAccum / inferCount).toFixed(2) : null;
      status.clipFrame = clipFrame;
      updateLiveSignals();
      ui.updateMetrics(status, clip);
      ctrlCount = 0;
      frameCount = 0;
      inferAccum = 0;
      inferCount = 0;
      windowStart = now;
    }

    requestAnimationFrame(frame);
  }

  function updateLiveSignals(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xpos: any = sim.data.xpos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xquat: any = sim.data.xquat;
    const b = controller.baseBodyId;
    const h = xpos[b * 3 + 2] as number;
    status.pelvisHeight = +h.toFixed(3);
    // Upright signal: projected-gravity Z in base frame; -1 when upright, → 0
    // when tipped to horizontal, > 0 when upside down.
    const qw = xquat[b * 4] as number;
    const qx = xquat[b * 4 + 1] as number;
    const qy = xquat[b * 4 + 2] as number;
    const qz = xquat[b * 4 + 3] as number;
    // gravity (0,0,-1) into base: z' = -(1 - 2(qx^2+qy^2)) = -(qw^2-qx^2-qy^2+qz^2)
    const gz = -(qw * qw - qx * qx - qy * qy + qz * qz);
    status.upright = +gz.toFixed(3);
    // "fell" = pelvis low for ~1 s straight.
    if (h < 0.45) fellFrames += 1;
    else fellFrames = 0;
    status.fell = fellFrames >= 1;
  }

  // Smoothly pan the camera to follow the robot's horizontal drift (it walks
  // around the scene). We move the orbit target + camera by the same delta, so
  // the user's orbit angle and zoom are preserved.
  const followTarget = new Vector3();
  const prevFollow = new Vector3();
  let followInit = false;
  function followRobot(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xpos: any = sim.data.xpos;
    const b = controller.baseBodyId;
    // MuJoCo Z-up world (x,y,z) → Three Y-up (x, z, -y), matching bind-glb's
    // Z_UP_TO_Y_UP wrapper. Track the robot's HORIZONTAL (x, -y) ground position;
    // Y (up) is left to the user so the camera doesn't chase vertical bob.
    followTarget.set(xpos[b * 3] as number, 0, -(xpos[b * 3 + 1] as number));
    if (!followInit) {
      prevFollow.copy(followTarget);
      followInit = true;
      return;
    }
    // Ground-plane delta only (no Y) so there's no vertical feedback runaway.
    const dx = (followTarget.x - prevFollow.x) * 0.1;
    const dz = (followTarget.z - prevFollow.z) * 0.1;
    viewer.controls.target.x += dx;
    viewer.controls.target.z += dz;
    viewer.camera.position.x += dx;
    viewer.camera.position.z += dz;
    prevFollow.x += dx;
    prevFollow.z += dz;
  }

  ui.onPlayPause(() => {
    status.playing = !status.playing;
    ui.setPlaying(status.playing);
  });
  ui.onReset(() => resetToStart());

  status.ready = true;
  ui.setPlaying(true);
  requestAnimationFrame(frame);
}

/** Inject an <option> after the opening <mujoco …> tag to pin physics timing. */
function pinPhysicsOption(xml: string): string {
  if (/<option[\s>]/.test(xml)) return xml; // already has one
  const option =
    `\n  <option timestep="${PHYS_TIMESTEP}" integrator="${INTEGRATOR}" ` +
    `iterations="${SOLVER_ITER}" ls_iterations="${SOLVER_LS_ITER}"/>`;
  return xml.replace(/(<mujoco\b[^>]*>)/, `$1${option}`);
}

function fail(msg: string): void {
  status.error = msg;
  ui.setStatus(`FAILED: ${msg}`, true);
  console.error(`[live] ${msg}`);
}

function frameViewer(viewer: Viewer, target: import('three').Object3D): void {
  // The geom meshes set matrixAutoUpdate=false, so their world matrices are
  // stale until the first render. Force an update or the bbox collapses to the
  // origin and the camera zooms into the feet.
  target.updateWorldMatrix(true, true);
  const box = new Box3().setFromObject(target);
  if (box.isEmpty()) return;
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  // Clamp the radius so a low first frame (lying clips) or a not-yet-synced
  // bbox can't frame too tight; aim at the torso, not the ground.
  const radius = Math.max(size.x, size.y, size.z, 1.1);
  const targetY = Math.max(center.y, 0.7);
  viewer.controls.target.set(center.x, targetY, center.z);
  viewer.camera.position.set(
    center.x + radius * 1.3,
    targetY + radius * 0.55,
    center.z + radius * 1.9,
  );
  viewer.camera.near = radius / 100;
  viewer.camera.far = radius * 100;
  viewer.camera.updateProjectionMatrix();
}

// ---- HUD chrome (telemetry console: status pill, clip picker, readouts) -----
function buildUi() {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('#app missing');
  root.innerHTML = `
    <div class="live" id="lv-root" data-state="boot">
      <div class="live__stage" id="lv-viewport"></div>
      <div class="live__vignette" aria-hidden="true"></div>

      <header class="live__topbar">
        <div class="live__brand">
          <span class="live__dot" aria-hidden="true"></span>
          <span class="live__wordmark">G1&nbsp;·&nbsp;<b>WBC</b></span>
          <span class="live__state" id="lv-state">boot</span>
        </div>
        <div class="live__status" id="lv-status">booting…</div>
        <div class="live__controls">
          <label class="live__select"><span>clip</span><select id="lv-clip"></select></label>
          <button id="lv-play" class="live__btn live__btn--primary">⏸&nbsp;pause</button>
          <button id="lv-reset" class="live__btn">↺&nbsp;reset</button>
        </div>
      </header>

      <footer class="live__telemetry" id="lv-metrics"></footer>
      <div class="live__progress" aria-hidden="true"><span id="lv-progress"></span></div>
    </div>`;

  const rootEl = root.querySelector<HTMLElement>('#lv-root')!;
  const viewport = root.querySelector<HTMLElement>('#lv-viewport')!;
  const statusEl = root.querySelector<HTMLElement>('#lv-status')!;
  const stateEl = root.querySelector<HTMLElement>('#lv-state')!;
  const metricsEl = root.querySelector<HTMLElement>('#lv-metrics')!;
  const progressEl = root.querySelector<HTMLElement>('#lv-progress')!;
  const playEl = root.querySelector<HTMLButtonElement>('#lv-play')!;
  const resetEl = root.querySelector<HTMLButtonElement>('#lv-reset')!;
  const clipEl = root.querySelector<HTMLSelectElement>('#lv-clip')!;

  let playing = true;
  let latest: LiveStatus | undefined;

  // The live-state pill: error/fell (red) → boot (grey) → paused (amber) → live.
  function renderState(): void {
    let state = 'live';
    let label = 'live';
    if (latest?.error) { state = 'fell'; label = 'error'; }
    else if (latest?.fell) { state = 'fell'; label = 'fell'; }
    else if (!latest?.ready) { state = 'boot'; label = 'boot'; }
    else if (!playing) { state = 'paused'; label = 'paused'; }
    rootEl.dataset.state = state;
    stateEl.textContent = label;
  }

  return {
    viewport,
    setStatus(s: string, err = false) {
      statusEl.textContent = s;
      statusEl.style.color = err ? 'var(--color-danger)' : '';
      if (err) {
        rootEl.dataset.state = 'fell';
        stateEl.textContent = 'error';
      }
    },
    setPlaying(p: boolean) {
      playing = p;
      playEl.innerHTML = p ? '⏸&nbsp;pause' : '▶&nbsp;play';
      renderState();
    },
    onPlayPause(fn: () => void) {
      playEl.addEventListener('click', fn);
    },
    onReset(fn: () => void) {
      resetEl.addEventListener('click', fn);
    },
    populateClips(clips: ReferenceClip[], selectedId: string, fn: (id: string) => void) {
      clipEl.innerHTML = clips
        .map((c) => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.name}</option>`)
        .join('');
      clipEl.addEventListener('change', () => fn(clipEl.value));
    },
    updateMetrics(s: LiveStatus, _clip?: ReferenceClip) {
      latest = s;
      renderState();
      metricsEl.innerHTML = [
        tm('realtime', s.realtime != null ? `${s.realtime}×` : '…', toneRealtime(s.realtime)),
        tm('ctrl', s.controlHz != null ? `${s.controlHz} Hz` : '…'),
        tm('fps', s.fps ?? '…'),
        tm('infer', s.inferMs != null ? `${s.inferMs} ms` : '…'),
        tm('upright', s.upright != null ? s.upright.toFixed(2) : '…', toneUpright(s.upright)),
        tm('pelvis z', s.pelvisHeight != null ? `${s.pelvisHeight} m` : '…', tonePelvis(s.pelvisHeight)),
        tm('frame', s.clipFrame != null ? `${s.clipFrame}/${s.clipFrames}` : '…'),
        tm('obs', s.modelObsDim != null ? `${s.obsDim}/${s.modelObsDim}` : '…'),
        tm('act', s.actionDim ?? '…'),
        tm('load', s.loadMs != null ? `${s.loadMs} ms` : '…'),
      ].join('');
      if (s.clipFrame != null && s.clipFrames) {
        progressEl.style.width = `${((s.clipFrame / s.clipFrames) * 100).toFixed(1)}%`;
      }
    },
  };
}

/** One telemetry readout: tracked micro-label over a tabular value. */
function tm(k: string, v: unknown, tone = ''): string {
  const attr = tone ? ` data-tone="${tone}"` : '';
  return `<div class="tm"${attr}><span class="tm__k">${k}</span><span class="tm__v">${v}</span></div>`;
}

// Health tones for the live signals: green healthy → amber marginal → red bad.
function toneRealtime(x: number | null): string {
  if (x == null) return '';
  return x >= 0.9 ? 'ok' : x >= 0.5 ? 'warn' : 'bad';
}
function toneUpright(x: number | null): string {
  if (x == null) return '';
  return x <= -0.85 ? 'ok' : x <= -0.5 ? 'warn' : 'bad';
}
function tonePelvis(x: number | null): string {
  if (x == null) return '';
  return x > 0.6 ? 'ok' : x >= 0.45 ? 'warn' : 'bad';
}

void main();
