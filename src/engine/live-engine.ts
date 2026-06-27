/**
 * Live WBC engine — reusable, DOM-free.
 *
 * Mounts a mujoco-wasm physics sim + onnxruntime-web policy + the deploy
 * obs/action/PD pipeline into a Three.js viewport and exposes an imperative
 * control surface (play/pause, clip switch, speed, policy/open-loop, perturb,
 * camera). Both the per-policy page and the gallery's live cards drive it; the
 * UI chrome lives in the page, not here.
 *
 * Extracted from the tracer-bullet spike (`spike/live-page.ts`, issue
 * wbc-mjlab-uxq); see that file's header for the loop math + timing rationale.
 * Issues: wbc-mjlab-e9w (controls), wbc-mjlab-g8h (per-policy page + gallery).
 */

import { Box3, Vector3 } from 'three';
import { Viewer } from '../viewer/renderer';
import { loadG1Sim, type MujocoSim } from '../spike/mujoco';
import { buildGeomRenderer, type GeomBinding } from '../spike/geom-renderer';
import {
  loadPolicyConfig,
  loadReferenceIndex,
  loadReferenceStream,
  type PolicyConfig,
  type ReferenceClip,
  type ReferenceIndex,
  type ReferenceStream,
} from '../spike/policy-config';
import { loadPolicy, type PolicyRunner } from '../spike/policy-runner';
import { makeWbcController, type WbcController } from '../spike/wbc-controller';

// Training-parity physics timing (wbc-mjlab SimulationCfg / MujocoCfg).
const PHYS_TIMESTEP = 0.005;
const SOLVER_ITER = 10;
const SOLVER_LS_ITER = 20;
const INTEGRATOR = 'implicitfast';
const SCENE_XML = 'scene_g1.xml';

// The 34 STL basenames referenced by scene_g1.xml.
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

export type EngineMode = 'policy' | 'open-loop';

export interface LiveStatus {
  ready: boolean;
  error: string | null;
  loadMs: number | null;
  obsDim: number | null;
  modelObsDim: number | null;
  actionDim: number | null;
  decimation: number | null;
  controlHz: number | null;
  fps: number | null;
  realtime: number | null;
  speed: number;
  mode: EngineMode;
  clipId: string | null;
  clipName: string | null;
  clipFrame: number | null;
  clipFrames: number | null;
  pelvisHeight: number | null;
  upright: number | null;
  fell: boolean;
  playing: boolean;
  inferMs: number | null;
}

export interface LiveEngineOptions {
  /** Policy folder URL (Vite-base prefixed), e.g. `/wbc-demo/policies/g1-samples/`. */
  policyBaseUrl: string;
  /** Robot MJCF asset dir, e.g. `/wbc-demo/robots/g1/mjcf/`. */
  mjcfBaseUrl: string;
  startClipId?: string;
  /** Begin playing immediately once loaded (default true). */
  autoplay?: boolean;
  /** Pan the camera to follow the base as it locomotes (default true). */
  follow?: boolean;
  /** Cheaper viewport for many simultaneous instances (gallery cards). */
  lowQuality?: boolean;
  /** Called ~once/second with a fresh status snapshot. */
  onStatus?: (s: Readonly<LiveStatus>) => void;
  /** Called once the clip list is known (for building a picker). */
  onReady?: (clips: ReferenceClip[]) => void;
  /** Called whenever the active clip changes. */
  onClip?: (clip: ReferenceClip) => void;
  /** Called on a fatal load error. */
  onError?: (msg: string) => void;
  /** Status message sink (loading progress + clip names). */
  onMessage?: (msg: string) => void;
}

export interface LiveEngineHandle {
  readonly viewer: Viewer;
  readonly clips: ReferenceClip[];
  readonly status: Readonly<LiveStatus>;
  play(): void;
  pause(): void;
  /** Flip play/pause; returns the new playing state. */
  toggle(): boolean;
  reset(): void;
  selectClip(id: string): Promise<void>;
  /** Playback/sim-time multiplier (clamped 0.1–4). */
  setSpeed(x: number): void;
  setMode(m: EngineMode): void;
  /** Shove the base with a horizontal impulse (m/s); random direction. */
  perturb(magnitude?: number): void;
  /** Re-frame the camera on the robot. */
  reframe(): void;
  setFollow(on: boolean): void;
  /** Move the viewport canvas into a new container (engine-pool reuse). */
  reparent(container: HTMLElement): void;
  dispose(): void;
}

/** Inject an <option> after the opening <mujoco …> tag to pin physics timing. */
function pinPhysicsOption(xml: string): string {
  if (/<option[\s>]/.test(xml)) return xml;
  const option =
    `\n  <option timestep="${PHYS_TIMESTEP}" integrator="${INTEGRATOR}" ` +
    `iterations="${SOLVER_ITER}" ls_iterations="${SOLVER_LS_ITER}"/>`;
  return xml.replace(/(<mujoco\b[^>]*>)/, `$1${option}`);
}

export async function createLiveEngine(
  container: HTMLElement,
  opts: LiveEngineOptions,
): Promise<LiveEngineHandle> {
  const status: LiveStatus = {
    ready: false, error: null, loadMs: null,
    obsDim: null, modelObsDim: null, actionDim: null, decimation: null,
    controlHz: null, fps: null, realtime: null, speed: 1, mode: 'policy',
    clipId: null, clipName: null, clipFrame: null, clipFrames: null,
    pelvisHeight: null, upright: null, fell: false,
    playing: opts.autoplay !== false, inferMs: null,
  };
  const msg = (s: string) => opts.onMessage?.(s);
  const t0 = performance.now();

  msg('Loading config + reference index…');
  let cfg: PolicyConfig;
  let refIndex: ReferenceIndex;
  try {
    [cfg, refIndex] = await Promise.all([
      loadPolicyConfig(`${opts.policyBaseUrl}config.yaml`),
      loadReferenceIndex(`${opts.policyBaseUrl}reference/index.json`),
    ]);
  } catch (err) {
    const m = `config/index load failed: ${String(err)}`;
    status.error = m; opts.onError?.(m); throw new Error(m);
  }
  status.obsDim = cfg.obsDim;
  status.decimation = Math.round(cfg.policyStepDt / PHYS_TIMESTEP);

  msg('Loading MuJoCo WASM + policy…');
  let sim: MujocoSim;
  let policy: PolicyRunner;
  try {
    [sim, policy] = await Promise.all([
      loadG1Sim({
        baseUrl: opts.mjcfBaseUrl,
        sceneXml: SCENE_XML,
        meshFiles: MESH_FILES,
        xmlTransform: pinPhysicsOption,
        onProgress: (n, total) => msg(`Fetching meshes ${n}/${total}…`),
      }),
      loadPolicy({
        url: `${opts.policyBaseUrl}policy.onnx`,
        expectedObsDim: cfg.obsDim,
        expectedActionDim: cfg.jointNames.length,
      }),
    ]);
  } catch (err) {
    const m = `engine load failed: ${String(err)}`;
    status.error = m; opts.onError?.(m); throw new Error(m);
  }
  status.modelObsDim = policy.obsDim;
  status.actionDim = policy.actionDim;
  status.loadMs = Math.round(performance.now() - t0);
  if (cfg.obsDim !== policy.obsDim) {
    const m = `obs dim mismatch: assembled ${cfg.obsDim} vs model ${policy.obsDim}`;
    status.error = m; opts.onError?.(m); throw new Error(m);
  }

  const viewer = new Viewer(container, { lowQuality: opts.lowQuality });
  const ph = viewer.robotRoot.getObjectByName('placeholder-robot');
  if (ph) viewer.robotRoot.remove(ph);
  const robot: GeomBinding = buildGeomRenderer({
    sim, parent: viewer.robotRoot, includeGroups: new Set([1, 2]),
  });
  const controller: WbcController = makeWbcController({ sim, cfg, policy });

  // ---- clip + run state ----------------------------------------------------
  let stream: ReferenceStream;
  let clipFrame = 0;
  let fellFrames = 0;
  let follow = opts.follow !== false;
  let speed = 1;
  let mode: EngineMode = 'policy';
  const followTarget = new Vector3();
  const prevFollow = new Vector3();
  let followInit = false;

  async function selectClip(id: string): Promise<void> {
    const c = refIndex.clips.find((x) => x.id === id) ?? refIndex.clips[0];
    if (!c) throw new Error('reference index has no clips');
    msg(`Loading clip ${c.name}…`);
    stream = await loadReferenceStream(`${opts.policyBaseUrl}reference/${c.file}`, refIndex.commandDim);
    status.clipId = c.id;
    status.clipName = c.name;
    status.clipFrames = stream.frames;
    resetToStart();
    opts.onClip?.(c);
    msg(`Tracking “${c.name}” (${stream.frames} frames)`);
  }

  function resetToStart(): void {
    clipFrame = 0;
    controller.resetToReference(stream.frame(0));
    robot.sync(sim);
    status.fell = false;
    fellFrames = 0;
    followInit = false;
  }

  const startId =
    opts.startClipId ??
    refIndex.clips.find((c) => c.id === 'walk1_subject1')?.id ??
    refIndex.clips[0]?.id;
  if (!startId) {
    const m = 'reference index has no clips';
    status.error = m; opts.onError?.(m); throw new Error(m);
  }
  await selectClip(startId);
  frameViewer();
  opts.onReady?.(refIndex.clips);

  // ---- control + render loop ----------------------------------------------
  const policyDt = cfg.policyStepDt;
  const decimation = status.decimation!;
  let last = performance.now();
  let acc = 0;
  let ctrlCount = 0;
  let frameCount = 0;
  let windowStart = performance.now();
  let inferAccum = 0;
  let inferCount = 0;
  let stepping = false;
  let running = true;
  let rafId = 0;

  async function controlStep(): Promise<void> {
    const tI = performance.now();
    if (mode === 'policy') {
      await controller.step(stream.frame(clipFrame));
    } else {
      controller.holdReference(stream.frame(clipFrame));
    }
    inferAccum += performance.now() - tI;
    inferCount += 1;
    for (let s = 0; s < decimation; s++) {
      controller.applyTorque();
      sim.mujoco.mj_step(sim.model, sim.data);
    }
    ctrlCount += 1;
    if (status.playing) {
      clipFrame += 1;
      if (clipFrame >= stream.frames) clipFrame = 0;
    }
  }

  function frame(): void {
    if (!running) return;
    const now = performance.now();
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.1) elapsed = 0.1;
    acc += elapsed * speed;

    if (!stepping && acc >= policyDt) {
      stepping = true;
      void (async () => {
        let budget = Math.max(4, Math.ceil(4 * speed));
        while (acc >= policyDt && budget-- > 0) {
          await controlStep();
          acc -= policyDt;
        }
        stepping = false;
      })();
    }

    robot.sync(sim);
    if (follow) followRobot();
    frameCount += 1;

    if (now - windowStart >= 1000) {
      const secs = (now - windowStart) / 1000;
      status.controlHz = Math.round(ctrlCount / secs);
      status.fps = Math.round(frameCount / secs);
      status.realtime = +(status.controlHz * policyDt).toFixed(2);
      status.inferMs = inferCount ? +(inferAccum / inferCount).toFixed(2) : null;
      status.clipFrame = clipFrame;
      status.speed = speed;
      status.mode = mode;
      updateLiveSignals();
      opts.onStatus?.(status);
      ctrlCount = 0; frameCount = 0; inferAccum = 0; inferCount = 0;
      windowStart = now;
    }
    rafId = requestAnimationFrame(frame);
  }

  function updateLiveSignals(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xpos: any = sim.data.xpos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xquat: any = sim.data.xquat;
    const b = controller.baseBodyId;
    const h = xpos[b * 3 + 2] as number;
    status.pelvisHeight = +h.toFixed(3);
    const qw = xquat[b * 4] as number;
    const qx = xquat[b * 4 + 1] as number;
    const qy = xquat[b * 4 + 2] as number;
    const qz = xquat[b * 4 + 3] as number;
    const gz = -(qw * qw - qx * qx - qy * qy + qz * qz);
    status.upright = +gz.toFixed(3);
    if (h < 0.45) fellFrames += 1; else fellFrames = 0;
    status.fell = fellFrames >= 1;
  }

  function followRobot(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xpos: any = sim.data.xpos;
    const b = controller.baseBodyId;
    followTarget.set(xpos[b * 3] as number, 0, -(xpos[b * 3 + 1] as number));
    if (!followInit) { prevFollow.copy(followTarget); followInit = true; return; }
    const dx = (followTarget.x - prevFollow.x) * 0.1;
    const dz = (followTarget.z - prevFollow.z) * 0.1;
    viewer.controls.target.x += dx;
    viewer.controls.target.z += dz;
    viewer.camera.position.x += dx;
    viewer.camera.position.z += dz;
    prevFollow.x += dx;
    prevFollow.z += dz;
  }

  function frameViewer(): void {
    // geom meshes use matrixAutoUpdate=false; refresh world bounds before measuring.
    robot.root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(robot.root);
    if (box.isEmpty()) return;
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
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
    followInit = false;
  }

  status.ready = true;
  rafId = requestAnimationFrame(frame);

  return {
    viewer,
    clips: refIndex.clips,
    status,
    play() { status.playing = true; },
    pause() { status.playing = false; },
    toggle() { status.playing = !status.playing; return status.playing; },
    reset() { resetToStart(); },
    selectClip,
    setSpeed(x: number) { speed = Math.min(4, Math.max(0.1, x)); status.speed = speed; },
    setMode(m: EngineMode) {
      mode = m; status.mode = m;
      if (m === 'open-loop') controller.resetActions();
    },
    perturb(magnitude = 3.0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qvel: any = sim.data.qvel;
      const theta = (clipFrame % 360) * (Math.PI / 180); // deterministic-ish direction
      qvel[0] = (qvel[0] as number) + Math.cos(theta) * magnitude;
      qvel[1] = (qvel[1] as number) + Math.sin(theta) * magnitude;
    },
    reframe() { frameViewer(); },
    setFollow(on: boolean) { follow = on; followInit = false; },
    reparent(el: HTMLElement) { viewer.reparent(el); },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      viewer.dispose();
    },
  };
}
