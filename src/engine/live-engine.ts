/**
 * Live WBC engine — reusable, DOM-free.
 *
 * Mounts a mujoco-wasm physics sim + onnxruntime-web policy + the deploy
 * obs/action/PD pipeline into a Three.js viewport and exposes an imperative
 * control surface (play/pause, clip switch, speed, policy/open-loop, perturb,
 * camera). Both the per-policy page and the gallery's live cards drive it; the
 * UI chrome lives in the page, not here.
 *
 * Distilled from the original tracer-bullet spike (since removed); the loop
 * math + training-parity timing rationale live inline below.
 */

import {
  Box3,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Raycaster,
  Vector2,
  Vector3,
} from 'three';
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
import {
  browsableClipsWithoutManifest,
  defaultBrowsableClip,
  loadClipManifest,
  resolveBrowsableClips,
  resolvePoseClip,
  type ClipManifest,
} from './clip-manifest';
import {
  browseNext,
  browsePrev,
  canBrowseClips,
  canGetup,
  canLiedown,
  canPlaySelectedClip,
  createWbcFsm,
  enterClipSelectMode,
  fsmUiLabel,
  onClipFinished,
  startBrowsablePlayback,
  startPosePlayback,
  type ClipKind,
  type WbcFsmState,
} from './wbc-fsm';
import { loadPolicy, type PolicyRunner } from './policy-runner';
import { makeWbcController, type WbcController } from './wbc-controller';

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
  loop: boolean;
  robotIsUp: boolean;
  fsmLabel: string;
  canGetup: boolean;
  canLiedown: boolean;
  canBrowse: boolean;
  clipKind: ClipKind;
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
  /** Enable click-drag-to-perturb on the robot (per-policy page). */
  interactiveDrag?: boolean;
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
  /** Called when FSM gating changes (enable/disable pose buttons). */
  onFsm?: (s: Readonly<LiveStatus>) => void;
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
  /** Play the browsable clip highlighted in select mode (deploy: A). */
  playSelectedClip(): Promise<void>;
  browseNextClip(): Promise<void>;
  browsePrevClip(): Promise<void>;
  triggerGetup(): Promise<void>;
  triggerLiedown(): Promise<void>;
  /** Playback/sim-time multiplier (clamped 0.1–4). */
  setSpeed(x: number): void;
  setMode(m: EngineMode): void;
  /** Shove the base with a horizontal impulse (m/s); random direction. */
  perturb(magnitude?: number): void;
  /** Re-frame the camera on the robot. */
  reframe(): void;
  setFollow(on: boolean): void;
  /** Loop the current browsable clip when it reaches the end. */
  setLoop(on: boolean): void;
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
    playing: opts.autoplay !== false, inferMs: null, loop: false,
    robotIsUp: true, fsmLabel: 'select', canGetup: false, canLiedown: false,
    canBrowse: true, clipKind: 'browsable',
  };
  const msg = (s: string) => opts.onMessage?.(s);
  const t0 = performance.now();

  msg('Loading config + reference index…');
  let cfg: PolicyConfig;
  let refIndex: ReferenceIndex;
  let clipManifest: ClipManifest | null = null;
  try {
    [cfg, refIndex] = await Promise.all([
      loadPolicyConfig(`${opts.policyBaseUrl}config.yaml`),
      loadReferenceIndex(`${opts.policyBaseUrl}reference/index.json`),
    ]);
    try {
      clipManifest = await loadClipManifest(`${opts.policyBaseUrl}reference/manifest.yaml`);
    } catch {
      msg('No reference/manifest.yaml — showing all non-pose clips');
    }
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

  // ---- interactive drag-to-perturb (GEAR-SONIC style) ----------------------
  // Click-drag a body to apply a spring force toward the cursor, written to
  // MuJoCo's `data.xfrc_applied` (per-body, world frame). Grabbing the robot
  // suppresses orbit (capture-phase + stopPropagation beats OrbitControls);
  // dragging empty space orbits as usual.
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const targetThree = new Vector3(); // drag target, three.js world
  const bodyThree = new Vector3();
  let grabBody = -1;
  let grabDist = 0;
  let dragLine: Line | null = null;
  let detachDrag: (() => void) | null = null;

  function rayTargetThree(e: PointerEvent): void {
    const rect = viewer.renderer.domElement.getBoundingClientRect();
    ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, viewer.camera);
    targetThree.copy(raycaster.ray.origin).addScaledVector(raycaster.ray.direction, grabDist);
  }

  function setupDrag(): void {
    const el = viewer.renderer.domElement;
    const geom = new BufferGeometry().setFromPoints([new Vector3(), new Vector3()]);
    const mat = new LineBasicMaterial({ color: 0x36cfe0, depthTest: false, transparent: true });
    dragLine = new Line(geom, mat);
    dragLine.visible = false;
    dragLine.frustumCulled = false;
    dragLine.renderOrder = 999;
    viewer.scene.add(dragLine);

    const onDown = (e: PointerEvent): void => {
      if (e.button !== 0) return;
      robot.root.updateWorldMatrix(true, true);
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, viewer.camera);
      const hit = raycaster.intersectObjects(robot.pickMeshes, false)[0];
      const bid = hit?.object.userData.bodyId as number | undefined;
      if (hit && bid != null && bid >= 1) {
        grabBody = bid;
        grabDist = hit.distance;
        targetThree.copy(hit.point);
        viewer.controls.enabled = false;
        if (dragLine) dragLine.visible = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        e.stopPropagation(); // capture phase → beats OrbitControls' pointerdown
      }
    };
    const onMove = (e: PointerEvent): void => {
      if (grabBody >= 0) rayTargetThree(e);
    };
    const onUp = (e: PointerEvent): void => {
      if (grabBody < 0) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const xfrc: any = sim.data.xfrc_applied;
      for (let i = 0; i < 6; i++) xfrc[grabBody * 6 + i] = 0;
      grabBody = -1;
      viewer.controls.enabled = true;
      if (dragLine) dragLine.visible = false;
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };

    el.addEventListener('pointerdown', onDown, true);
    el.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    detachDrag = () => {
      el.removeEventListener('pointerdown', onDown, true);
      el.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (dragLine) {
        viewer.scene.remove(dragLine);
        dragLine.geometry.dispose();
        (dragLine.material as LineBasicMaterial).dispose();
      }
    };
  }

  /** Each frame: spring the grabbed body toward the cursor via xfrc_applied. */
  function applyDrag(): void {
    if (grabBody < 0) return;
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const xpos: any = sim.data.xpos;
    const xfrc: any = sim.data.xfrc_applied;
    const mass = (sim.model.body_mass as any)[grabBody] as number;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const bx = xpos[grabBody * 3] as number;
    const by = xpos[grabBody * 3 + 1] as number;
    const bz = xpos[grabBody * 3 + 2] as number;
    // Drag target three (X,Y,Z) → MuJoCo Z-up (X, -Z, Y).
    const tx = targetThree.x;
    const ty = -targetThree.z;
    const tz = targetThree.y;
    const K = 120; // spring stiffness, N per (kg·m)
    const maxF = 800;
    let fx = K * mass * (tx - bx);
    let fy = K * mass * (ty - by);
    let fz = K * mass * (tz - bz);
    const m = Math.hypot(fx, fy, fz);
    if (m > maxF) { const s = maxF / m; fx *= s; fy *= s; fz *= s; }
    xfrc[grabBody * 6] = fx;
    xfrc[grabBody * 6 + 1] = fy;
    xfrc[grabBody * 6 + 2] = fz;
    if (dragLine) {
      bodyThree.set(bx, bz, -by); // MuJoCo → three
      const pos = dragLine.geometry.getAttribute('position');
      pos.setXYZ(0, bodyThree.x, bodyThree.y, bodyThree.z);
      pos.setXYZ(1, targetThree.x, targetThree.y, targetThree.z);
      pos.needsUpdate = true;
    }
  }

  if (opts.interactiveDrag) setupDrag();

  // ---- clip + FSM state (wbc-g1-deploy Wbc_Tracking) -----------------------
  let stream: ReferenceStream;
  let clipFrame = 0;
  let fellFrames = 0;
  let follow = opts.follow !== false;
  let loopClip = false;
  let speed = 1;
  let mode: EngineMode = 'policy';
  const followTarget = new Vector3();
  const viewCenter = new Vector3();
  const viewSize = new Vector3();
  let followInit = false;

  const browsableClips = clipManifest
    ? resolveBrowsableClips(refIndex, clipManifest)
    : browsableClipsWithoutManifest(refIndex);
  if (!browsableClips.length) {
    const m = 'clip manifest resolved to zero browsable clips';
    status.error = m; opts.onError?.(m); throw new Error(m);
  }

  let fsm: WbcFsmState = createWbcFsm(0);
  let activeKind: ClipKind = 'browsable';

  function syncFsmStatus(): void {
    status.robotIsUp = fsm.robotIsUp;
    status.fsmLabel = fsmUiLabel(fsm);
    status.canGetup = canGetup(fsm);
    status.canLiedown = canLiedown(fsm);
    status.canBrowse = canBrowseClips(fsm);
    status.clipKind = activeKind;
    opts.onFsm?.(status);
  }

  async function loadClipStream(c: ReferenceClip): Promise<void> {
    msg(`Loading clip ${c.name}…`);
    stream = await loadReferenceStream(
      `${opts.policyBaseUrl}reference/${c.file}`,
      refIndex.commandDim,
    );
    status.clipId = c.id;
    status.clipName = c.name;
    status.clipFrames = stream.frames;
    opts.onClip?.(c);
  }

  async function loadClip(
    c: ReferenceClip,
    kind: ClipKind,
    autoplay: boolean,
    resetPose = false,
  ): Promise<void> {
    activeKind = kind;
    await loadClipStream(c);
    clipFrame = 0;
    // Deploy applyMotionLoader: swap reference + reset policy episode, not robot qpos.
    if (resetPose) {
      controller.resetToReference(stream.frame(0));
      status.fell = false;
      fellFrames = 0;
    } else {
      controller.resetActions();
    }
    robot.sync(sim);
    followInit = false;
    if (autoplay) {
      if (kind === 'browsable') startBrowsablePlayback(fsm);
      else startPosePlayback(fsm, kind);
      status.playing = true;
    } else {
      enterClipSelectMode(fsm);
      status.playing = false;
    }
    syncFsmStatus();
    msg(`Tracking “${c.name}” (${stream.frames} frames)`);
  }

  async function selectClip(id: string): Promise<void> {
    const idx = browsableClips.findIndex((x) => x.id === id);
    const c = idx >= 0 ? browsableClips[idx] : browsableClips[0];
    if (!c) throw new Error('no browsable clips');
    fsm.selectedBrowsableIndex = idx >= 0 ? idx : 0;
    await loadClip(c, 'browsable', true, false);
  }

  async function playSelectedClip(): Promise<void> {
    if (!canPlaySelectedClip(fsm)) return;
    const c = browsableClips[fsm.selectedBrowsableIndex];
    if (!c) return;
    await loadClip(c, 'browsable', true, false);
  }

  async function browseNextClip(): Promise<void> {
    browseNext(fsm, browsableClips.length);
    syncFsmStatus();
    if (!canBrowseClips(fsm)) return;
    const c = browsableClips[fsm.selectedBrowsableIndex]!;
    await loadClip(c, 'browsable', true, false);
  }

  async function browsePrevClip(): Promise<void> {
    browsePrev(fsm, browsableClips.length);
    syncFsmStatus();
    if (!canBrowseClips(fsm)) return;
    const c = browsableClips[fsm.selectedBrowsableIndex]!;
    await loadClip(c, 'browsable', true, false);
  }

  async function triggerGetup(): Promise<void> {
    if (!canGetup(fsm)) return;
    const c = resolvePoseClip(refIndex, clipManifest, 'getup');
    if (!c) {
      msg('getup clip missing from reference index');
      return;
    }
    await loadClip(c, 'pose_getup', true, false);
  }

  async function triggerLiedown(): Promise<void> {
    if (!canLiedown(fsm)) return;
    const c = resolvePoseClip(refIndex, clipManifest, 'liedown');
    if (!c) {
      msg('liedown clip missing from reference index');
      return;
    }
    await loadClip(c, 'pose_liedown', true, false);
  }

  function resetToStart(): void {
    clipFrame = 0;
    controller.resetToReference(stream.frame(0));
    robot.sync(sim);
    status.fell = false;
    fellFrames = 0;
    followInit = false;
    if (fsm.robotIsUp) enterClipSelectMode(fsm);
    syncFsmStatus();
  }

  function finishClipPlayback(): void {
    if (loopClip && activeKind === 'browsable') {
      clipFrame = 0;
      controller.resetActions();
      status.playing = true;
      startBrowsablePlayback(fsm);
      syncFsmStatus();
      return;
    }
    clipFrame = Math.max(0, stream.frames - 1);
    onClipFinished(fsm);
    status.playing = false;
    syncFsmStatus();
  }

  const startClip =
    browsableClips.find((c) => c.id === opts.startClipId) ??
    defaultBrowsableClip(browsableClips, clipManifest);
  if (!startClip) {
    const m = 'no default browsable clip';
    status.error = m; opts.onError?.(m); throw new Error(m);
  }
  fsm.selectedBrowsableIndex = Math.max(0, browsableClips.indexOf(startClip));
  await loadClip(startClip, 'browsable', opts.autoplay !== false, true);
  frameViewer();
  opts.onReady?.(browsableClips);

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
    if (status.playing && fsm.clipPlaybackActive) {
      if (clipFrame >= stream.frames - 1) {
        finishClipPlayback();
      } else {
        clipFrame += 1;
      }
    }
  }

  function frame(): void {
    if (!running) return;
    const now = performance.now();
    let elapsed = (now - last) / 1000;
    last = now;
    if (elapsed > 0.1) elapsed = 0.1;
    acc += elapsed * speed;

    applyDrag(); // set xfrc_applied before stepping so mj_step sees the drag force

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
    if (h < 0.45 && fsm.robotIsUp) fellFrames += 1;
    else fellFrames = 0;
    status.fell = fsm.robotIsUp && fellFrames >= 1;
  }

  function robotViewRadius(): number | null {
    robot.root.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(robot.root);
    if (box.isEmpty()) return null;
    box.getCenter(viewCenter);
    box.getSize(viewSize);
    return Math.max(viewSize.x, viewSize.y, viewSize.z, 1.1);
  }

  function followRobot(): void {
    const radius = robotViewRadius();
    if (radius == null) return;
    const targetY = Math.max(viewCenter.y, 0.5);
    followTarget.set(viewCenter.x, targetY, viewCenter.z);

    if (!followInit) {
      viewer.controls.target.copy(followTarget);
      followInit = true;
      return;
    }

    const alpha = 0.14;
    const dx = (followTarget.x - viewer.controls.target.x) * alpha;
    const dy = (followTarget.y - viewer.controls.target.y) * alpha;
    const dz = (followTarget.z - viewer.controls.target.z) * alpha;
    viewer.controls.target.x += dx;
    viewer.controls.target.y += dy;
    viewer.controls.target.z += dz;
    viewer.camera.position.x += dx;
    viewer.camera.position.y += dy;
    viewer.camera.position.z += dz;
  }

  function frameViewer(): void {
    const radius = robotViewRadius();
    if (radius == null) return;
    const targetY = Math.max(viewCenter.y, 0.7);
    viewer.controls.target.set(viewCenter.x, targetY, viewCenter.z);
    viewer.camera.position.set(
      viewCenter.x + radius * 1.3,
      targetY + radius * 0.55,
      viewCenter.z + radius * 1.9,
    );
    viewer.camera.near = radius / 100;
    viewer.camera.far = radius * 100;
    viewer.camera.updateProjectionMatrix();
    followInit = true;
  }

  status.ready = true;
  rafId = requestAnimationFrame(frame);

  return {
    viewer,
    clips: browsableClips,
    status,
    play() {
      if (canPlaySelectedClip(fsm)) {
        void playSelectedClip();
        return;
      }
      if (fsm.clipPlaybackActive) status.playing = true;
    },
    pause() { status.playing = false; },
    toggle() {
      if (canPlaySelectedClip(fsm) && !status.playing) {
        void playSelectedClip();
        return true;
      }
      status.playing = !status.playing;
      return status.playing;
    },
    reset() { resetToStart(); },
    selectClip,
    playSelectedClip,
    browseNextClip,
    browsePrevClip,
    triggerGetup,
    triggerLiedown,
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
    setFollow(on: boolean) {
      follow = on;
      followInit = false;
    },
    setLoop(on: boolean) {
      loopClip = on;
      status.loop = on;
    },
    reparent(el: HTMLElement) { viewer.reparent(el); },
    dispose() {
      running = false;
      cancelAnimationFrame(rafId);
      detachDrag?.();
      viewer.dispose();
    },
  };
}
