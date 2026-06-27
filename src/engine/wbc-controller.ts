/**
 * The live WBC tracking controller — the in-browser port of `wbc-g1-deploy`.
 *
 * This is the heart of  (obs/action/PD port) and
 * (close the loop). Each 50 Hz control step it:
 *
 *   1. reads the current reference frame from the .bin stream (39 dims),
 *   2. reads live proprioception from the mujoco-wasm sim (base ang vel,
 *      projected gravity, joint pos/vel) + last action,
 *   3. assembles the 132-dim actor observation in `actor_observation_names`
 *      order, applying each term's scale,
 *   4. runs `policy.onnx` → 29 raw actions,
 *   5. turns actions into joint position targets via reference_residual:
 *      `target = action * action.scale + ref_joint_pos`,
 *   6. (deploy sends `target` to the robot's onboard PD; the MuJoCo scene uses
 *      direct-torque motors, so) computes `tau = kp*(target − q) − kd*qd` and
 *      writes `data.ctrl`, clamped to the actuator force range.
 *
 * Authoritative sources (ported here):
 *   - State_WbcTracking.cpp           — step order, action→q_cmd
 *   - observation_manager.h / manager_term_cfg.h — obs concat + scale
 *   - observations.h                  — base_ang_vel, projected_gravity,
 *                                        joint_pos(→joint_pos_rel),
 *                                        joint_vel(→joint_vel_rel),
 *                                        actions(→last_action)
 *   - wbc_mdp_registrations.cpp       — ReferenceJointPositionAction (residual)
 *   - joint_actions.h                 — action scale/offset/clip
 *   - unitree_articulation.h          — projected_gravity = q*.conj * (0,0,-1),
 *                                        base_ang_vel = imu gyro (base frame)
 *   - pd_torque_clip.cpp              — torque clipping (off by default here)
 *
 * KEY PARITY NOTE (subtle, silent if wrong): the exported config names the
 * proprio terms `joint_pos`, `joint_vel`, `actions`, but deploy renames them to
 * `joint_pos_rel`, `joint_vel_rel`, `last_action`. So:
 *   - `joint_pos` term  := q − default_joint_pos   (RELATIVE to default pose)
 *   - `joint_vel` term  := qd                       (raw; *_rel has no default)
 *   - `actions`  term   := last RAW policy output   (pre-scale, pre-residual)
 * (See wbc_tracking_params.cpp::observation_deploy_name.)
 */

import type { MujocoSim } from './mujoco';
import type { PolicyConfig } from './policy-config';
import type { PolicyRunner } from './policy-runner';

/** Reference-stream term offsets within the 39-dim command (see REFERENCE_STREAM.md). */
const REF_OFFSET = {
  base_height: 0, // 1
  base_lin_vel_b: 1, // 3
  base_ang_vel_b: 4, // 3
  gravity_b: 7, // 3
  joint_pos: 10, // 29
} as const;
const REF_JOINT_POS_OFFSET = REF_OFFSET.joint_pos;

/**
 * A built joint→MuJoCo address map (config joint order). Stored as typed arrays
 * so element access is `number` (sidesteps `noUncheckedIndexedAccess` for
 * indices that are provably in range, 0..n-1).
 */
interface JointMap {
  /** qpos scalar address for joint j (after the 7-dof free base). */
  qAdr: Int32Array;
  /** qvel scalar (dof) address for joint j. */
  vAdr: Int32Array;
  /** actuator index driving joint j. */
  actId: Int32Array;
  /** actuator ctrl (force) range lo/hi. */
  ctrlLo: Float64Array;
  ctrlHi: Float64Array;
}

export interface WbcController {
  /** The free-base body id (pelvis) used for proprio base frame. */
  readonly baseBodyId: number;
  /** Last assembled observation (for diagnostics). */
  readonly lastObs: Float32Array;
  /** Last raw policy action (for diagnostics + the `actions` obs term). */
  readonly lastAction: Float32Array;
  /** Last processed joint position targets. */
  readonly lastTarget: Float32Array;
  /** Run one 50 Hz control step against the CURRENT reference frame. */
  step(refFrame: Float32Array): Promise<void>;
  /**
   * Recompute the PD torque from the CURRENT sim state (holding the last action
   * target) and write it to `data.ctrl`. Call once before EACH physics substep
   * — like the trained IdealPdActuator, the PD law must see fresh q/qd each
   * substep, otherwise the in-period dynamics run open-loop and destabilise.
   */
  applyTorque(): void;
  /** Reset the robot to a reference frame's pose (on-distribution start). */
  resetToReference(refFrame: Float32Array): void;
  /** Zero the last action / target (e.g. on clip switch). */
  resetActions(): void;
  /**
   * Open-loop "policy off": zero the action and drive the PD straight at the
   * reference joint positions (no inference, no closed-loop balance). Lets the
   * UI contrast the policy's stabilisation against naive reference replay.
   */
  holdReference(refFrame: Float32Array): void;
}

/**
 * Build the joint map by resolving each config joint_name to its MuJoCo joint,
 * then to the qpos/qvel addresses and the actuator that drives it. Throws if a
 * joint or actuator is missing — i.e. the MJCF and config disagree.
 */
function buildJointMap(sim: MujocoSim, cfg: PolicyConfig): JointMap {
  const m = sim.model;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntQposAdr: any = m.jnt_qposadr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntDofAdr: any = m.jnt_dofadr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trnid: any = m.actuator_trnid; // [nu*2], joint id at [a*2]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrlRange: any = m.actuator_ctrlrange; // [nu*2]

  // Resolve joint name → joint id via the named joint accessor on data.
  const jointNameToId = new Map<string, number>();
  for (let j = 0; j < (m.njnt as number); j++) {
    const acc = sim.data.jnt(j);
    jointNameToId.set(acc.name, j);
    acc.delete();
  }

  // Resolve which actuator drives each joint id.
  const jointToActuator = new Map<number, number>();
  for (let a = 0; a < sim.nu; a++) {
    jointToActuator.set(trnid[a * 2] as number, a);
  }

  const names = cfg.jointNames;
  const n = names.length;
  const qAdr = new Int32Array(n);
  const vAdr = new Int32Array(n);
  const actId = new Int32Array(n);
  const ctrlLo = new Float64Array(n);
  const ctrlHi = new Float64Array(n);

  for (let j = 0; j < n; j++) {
    const name = names[j] as string;
    const jid = jointNameToId.get(name);
    if (jid == null) throw new Error(`wbc: MJCF has no joint "${name}"`);
    const a = jointToActuator.get(jid);
    if (a == null) throw new Error(`wbc: no actuator drives joint "${name}"`);
    qAdr[j] = jntQposAdr[jid] as number;
    vAdr[j] = jntDofAdr[jid] as number;
    actId[j] = a;
    ctrlLo[j] = ctrlRange[a * 2] as number;
    ctrlHi[j] = ctrlRange[a * 2 + 1] as number;
  }

  return { qAdr, vAdr, actId, ctrlLo, ctrlHi };
}

/** quat (w,x,y,z) conjugate applied to vector v: q.conj * v. */
function quatConjApply(
  qw: number,
  qx: number,
  qy: number,
  qz: number,
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  // q.conjugate() = (w, -x, -y, -z). Rotate v by it.
  const cx = -qx;
  const cy = -qy;
  const cz = -qz;
  // t = 2 * cross(q_vec, v)
  const tx = 2 * (cy * vz - cz * vy);
  const ty = 2 * (cz * vx - cx * vz);
  const tz = 2 * (cx * vy - cy * vx);
  // v' = v + w*t + cross(q_vec, t)
  return [
    vx + qw * tx + (cy * tz - cz * ty),
    vy + qw * ty + (cz * tx - cx * tz),
    vz + qw * tz + (cx * ty - cy * tx),
  ];
}

export function makeWbcController(opts: {
  sim: MujocoSim;
  cfg: PolicyConfig;
  policy: PolicyRunner;
}): WbcController {
  const { sim, cfg, policy } = opts;
  const n = cfg.jointNames.length; // 29
  const map = buildJointMap(sim, cfg);

  const baseBodyId = sim.bodyNameToId.get('pelvis');
  if (baseBodyId == null) throw new Error('wbc: MJCF has no "pelvis" body');
  const base: number = baseBodyId;

  // Per-joint config as typed arrays so element access is a plain `number`.
  const defaultJointPos = Float64Array.from(cfg.defaultJointPos);
  const actionScale = Float64Array.from(cfg.actionScale);
  const stiffness = Float64Array.from(cfg.stiffness);
  const damping = Float64Array.from(cfg.damping);

  const lastAction = new Float32Array(n); // raw policy output (== `actions` obs term)
  const lastTarget = new Float32Array(n);
  const lastTorque = new Float32Array(n);
  const obs = new Float32Array(cfg.obsDim);

  // Pre-flatten obs term scales into one array aligned with the obs layout, so
  // the per-step assembly is a straight multiply.
  const scaleFlat = new Float32Array(cfg.obsDim);
  {
    let k = 0;
    for (const t of cfg.obsTerms) {
      for (let i = 0; i < t.dim; i++) scaleFlat[k++] = t.scale[i] ?? 1.0;
    }
  }

  /**
   * Assemble the 132-dim obs in actor_observation_names order, writing raw
   * (pre-scale) values, then multiply by scaleFlat in one pass. Reference terms
   * come straight from the .bin frame; proprio terms come from the sim.
   */
  function assembleObs(refFrameArr: Float32Array): void {
    // Read indexed typed arrays through `any` locals so element access is `any`
    // (sidesteps noUncheckedIndexedAccess for provably-in-range indices — the
    // same pattern the spike uses for MuJoCo's typed-array views).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = refFrameArr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qAdr: any = map.qAdr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vAdr: any = map.vAdr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dflt: any = defaultJointPos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qpos: any = sim.data.qpos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qvel: any = sim.data.qvel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xquat: any = sim.data.xquat; // [nbody*4], world quat (w,x,y,z)

    // Base (pelvis) world orientation.
    const bq = base * 4;
    const qw = xquat[bq] as number;
    const qx = xquat[bq + 1] as number;
    const qy = xquat[bq + 2] as number;
    const qz = xquat[bq + 3] as number;

    // base_ang_vel: free-joint angular velocity. MuJoCo free-joint qvel ang
    // component (indices 3..5) is already expressed in the BASE frame — the
    // same quantity the deploy reads from the IMU gyro (body frame).
    const wx = qvel[3] as number;
    const wy = qvel[4] as number;
    const wz = qvel[5] as number;

    // projected_gravity: q.conj * (0,0,-1) — gravity unit vector in base frame.
    const [gx, gy, gz] = quatConjApply(qw, qx, qy, qz, 0, 0, -1);

    let k = 0;
    for (const t of cfg.obsTerms) {
      switch (t.name) {
        case 'ref_base_height':
          obs[k++] = ref[REF_OFFSET.base_height];
          break;
        case 'ref_base_lin_vel_b':
          obs[k++] = ref[REF_OFFSET.base_lin_vel_b];
          obs[k++] = ref[REF_OFFSET.base_lin_vel_b + 1];
          obs[k++] = ref[REF_OFFSET.base_lin_vel_b + 2];
          break;
        case 'ref_base_ang_vel_b':
          obs[k++] = ref[REF_OFFSET.base_ang_vel_b];
          obs[k++] = ref[REF_OFFSET.base_ang_vel_b + 1];
          obs[k++] = ref[REF_OFFSET.base_ang_vel_b + 2];
          break;
        case 'ref_gravity_b':
          obs[k++] = ref[REF_OFFSET.gravity_b];
          obs[k++] = ref[REF_OFFSET.gravity_b + 1];
          obs[k++] = ref[REF_OFFSET.gravity_b + 2];
          break;
        case 'ref_joint_pos':
          for (let j = 0; j < n; j++) obs[k++] = ref[REF_JOINT_POS_OFFSET + j];
          break;
        case 'base_ang_vel':
          obs[k++] = wx;
          obs[k++] = wy;
          obs[k++] = wz;
          break;
        case 'projected_gravity':
          obs[k++] = gx;
          obs[k++] = gy;
          obs[k++] = gz;
          break;
        case 'joint_pos':
          // deploy: joint_pos -> joint_pos_rel == q - default_joint_pos
          for (let j = 0; j < n; j++) {
            obs[k++] = (qpos[qAdr[j]] as number) - (dflt[j] as number);
          }
          break;
        case 'joint_vel':
          // deploy: joint_vel -> joint_vel_rel == qd (no default offset)
          for (let j = 0; j < n; j++) obs[k++] = qvel[vAdr[j]] as number;
          break;
        case 'actions': {
          // deploy: actions -> last_action == last RAW policy output
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const la: any = lastAction;
          for (let j = 0; j < n; j++) obs[k++] = la[j];
          break;
        }
        default:
          throw new Error(`wbc: unsupported obs term "${t.name}"`);
      }
    }
    if (k !== cfg.obsDim) throw new Error(`wbc: assembled ${k} obs != ${cfg.obsDim}`);

    // Apply per-term scales (all 1.0 for this policy, but honour the config).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sc: any = scaleFlat;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ob: any = obs;
    for (let i = 0; i < cfg.obsDim; i++) ob[i] *= sc[i];
  }

  /**
   * reference_residual: target_j = action_j * action.scale_j + ref_joint_pos_j.
   * Ports ReferenceJointPositionAction::process_actions (JointAction scale, then
   * += q_ref). No offset/clip configured for this policy.
   */
  function processActions(refFrameArr: Float32Array): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = refFrameArr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const la: any = lastAction;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asc: any = actionScale;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tgt: any = lastTarget;
    for (let j = 0; j < n; j++) {
      tgt[j] = la[j] * asc[j] + ref[REF_JOINT_POS_OFFSET + j];
    }
  }

  /**
   * Direct-torque PD: tau = kp*(target − q) − kd*qd, clamped to ctrlrange, and
   * written to data.ctrl. Recomputed from the CURRENT sim state on every call so
   * each physics substep sees fresh q/qd (matching the trained IdealPdActuator,
   * which runs the PD law every physics step at the same kp/kd). The deploy
   * sends `target` to the robot's onboard PD; the MuJoCo scene's <motor>s take
   * torque, so we close the PD loop here.
   */
  function applyTorque(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qpos: any = sim.data.qpos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qvel: any = sim.data.qvel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl: any = sim.data.ctrl;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qAdr: any = map.qAdr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vAdr: any = map.vAdr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actId: any = map.actId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kp: any = stiffness;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const kd: any = damping;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tgt: any = lastTarget;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lo: any = map.ctrlLo;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hi: any = map.ctrlHi;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tau: any = lastTorque;
    for (let j = 0; j < n; j++) {
      const q = qpos[qAdr[j]] as number;
      const qd = qvel[vAdr[j]] as number;
      let t = kp[j] * (tgt[j] - q) - kd[j] * qd;
      const l = lo[j] as number;
      const h = hi[j] as number;
      if (h > l) t = Math.min(h, Math.max(l, t));
      tau[j] = t;
      ctrl[actId[j]] = t;
    }
  }

  async function step(refFrame: Float32Array): Promise<void> {
    assembleObs(refFrame);
    const action = await policy.act(obs);
    lastAction.set(action.subarray(0, n));
    processActions(refFrame); // updates the held PD target; substeps recompute tau
  }

  function holdReference(refFrame: Float32Array): void {
    lastAction.fill(0); // == `actions` obs term were the policy to resume
    processActions(refFrame); // target = ref_joint_pos (action 0); no balance feedback
  }

  /**
   * Seed the robot on-distribution: set every joint to the reference frame's
   * ref_joint_pos, place the free base above the ground at the reference base
   * height with identity yaw, and zero all velocities. Then mj_forward so
   * xpos/xquat are valid for the first render/obs.
   */
  function resetToReference(refFrameArr: Float32Array): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qpos: any = sim.data.qpos;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qvel: any = sim.data.qvel;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ref: any = refFrameArr;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const qAdr: any = map.qAdr;
    const nq: number = sim.nq;
    const nv: number = sim.nv;

    for (let i = 0; i < nq; i++) qpos[i] = 0;
    for (let i = 0; i < nv; i++) qvel[i] = 0;

    // Set the joints to the reference frame's joint positions (on-distribution
    // start). The base goes upright at a provisional height; we then drop it so
    // the lowest body just touches the floor — starting with feet penetrating
    // the ground makes MuJoCo's contact solver violently eject the robot.
    qpos[0] = 0;
    qpos[1] = 0;
    qpos[2] = 1.0; // provisional; corrected below
    qpos[3] = 1; // quat w
    qpos[4] = 0;
    qpos[5] = 0;
    qpos[6] = 0;
    for (let j = 0; j < n; j++) qpos[qAdr[j]] = ref[REF_JOINT_POS_OFFSET + j];

    // Forward kinematics, find the lowest robot GEOM world-Z (the foot sole
    // geoms sit below the ankle body origin), and raise the base so it rests a
    // hair (5 mm) above the floor. Skip world-body geoms (the ground plane).
    sim.mujoco.mj_forward(sim.model, sim.data);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geomXpos: any = sim.data.geom_xpos; // [ngeom*3], world geom positions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const geomBodyId: any = sim.model.geom_bodyid; // [ngeom]
    const ngeom = sim.model.ngeom as number;
    let minZ = Infinity;
    for (let g = 0; g < ngeom; g++) {
      if ((geomBodyId[g] as number) === 0) continue; // skip ground/world geoms
      const z = geomXpos[g * 3 + 2] as number;
      if (z < minZ) minZ = z;
    }
    if (Number.isFinite(minZ)) qpos[2] = qpos[2] - minZ + 0.005;

    resetActions();
    sim.mujoco.mj_forward(sim.model, sim.data);
    void (ref[REF_OFFSET.base_height] as number); // (reference height kept for parity docs)
  }

  function resetActions(): void {
    lastAction.fill(0);
    lastTarget.fill(0);
    lastTorque.fill(0);
  }

  return {
    baseBodyId: base,
    lastObs: obs,
    lastAction,
    lastTarget,
    step,
    applyTorque,
    resetToReference,
    resetActions,
    holdReference,
  };
}
