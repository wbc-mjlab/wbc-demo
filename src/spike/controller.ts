/**
 * Trivial PD-hold controller — enough to prove ACTUATED stepping.
 *
 * SPIKE ONLY — issue wbc-mjlab-x2t. The scene's actuators are direct-torque
 * `<motor>`s, so we synthesise a torque per actuator that holds each joint at
 * its default pose (`qpos0`): tau = kp*(q0 - q) - kd*qvel, clamped to the
 * actuator ctrlrange. This is NOT the trained policy (that's wbc-mjlab-5sq) —
 * it just shows the actuators move the robot and the sim is genuinely stepping.
 */

import type { MujocoSim } from './mujoco';

const FREE_JOINT = 0; // mjtJoint: mjJNT_FREE

export interface PdController {
  /** Write actuator torques into `data.ctrl` for the current state. */
  apply(sim: MujocoSim): void;
}

interface ActuatorMap {
  qAdr: number;
  vAdr: number;
  target: number;
  lo: number;
  hi: number;
  limited: boolean;
}

/**
 * Build a PD-hold controller. For each actuator we resolve the driven joint
 * (via `actuator_trnid`), then its scalar qpos/qvel address, and the default
 * target from `qpos0`.
 *
 * MuJoCo model/data arrays are exposed as live typed-array views but declared
 * `any` in the bindings; we read them through `any`-typed locals so element
 * access is `any` (sidestepping `noUncheckedIndexedAccess` for indices that are
 * provably in range).
 */
export function makePdHold(
  sim: MujocoSim,
  gains: { kp: number; kd: number } = { kp: 80, kd: 4 },
): PdController {
  const m = sim.model;
  const nu = sim.nu;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trnid: any = m.actuator_trnid; // [nu*2], joint id in [.,0]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntQposAdr: any = m.jnt_qposadr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntDofAdr: any = m.jnt_dofadr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntType: any = m.jnt_type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qpos0: any = m.qpos0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctrlRange: any = m.actuator_ctrlrange; // [nu*2]
  // NB: `actuator_ctrllimited` is a memory_view<bool> that THIS wasm build does
  // not register a JS type for — accessing it throws a BindingError. We instead
  // treat a finite, non-degenerate ctrlrange as "limited" and always clamp to
  // it (harmless: all G1 motors declare a ctrlrange). See report for details.

  const map: ActuatorMap[] = [];
  for (let a = 0; a < nu; a++) {
    const jid: number = trnid[a * 2];
    if (jntType[jid] === FREE_JOINT) {
      map.push({ qAdr: -1, vAdr: -1, target: 0, lo: 0, hi: 0, limited: false });
      continue;
    }
    const qAdr: number = jntQposAdr[jid];
    const vAdr: number = jntDofAdr[jid];
    const lo: number = ctrlRange[a * 2];
    const hi: number = ctrlRange[a * 2 + 1];
    map.push({
      qAdr,
      vAdr,
      target: qpos0[qAdr],
      lo,
      hi,
      limited: Number.isFinite(lo) && Number.isFinite(hi) && hi > lo,
    });
  }

  const { kp, kd } = gains;

  return {
    apply(s: MujocoSim): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qpos: any = s.data.qpos;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qvel: any = s.data.qvel;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctrl: any = s.data.ctrl;
      for (let a = 0; a < nu; a++) {
        const e = map[a];
        if (!e || e.qAdr < 0) continue;
        let tau = kp * (e.target - qpos[e.qAdr]) - kd * qvel[e.vAdr];
        if (e.limited) tau = Math.min(e.hi, Math.max(e.lo, tau));
        ctrl[a] = tau;
      }
    },
  };
}

/**
 * Optional kinematic base-hold. The naive PD controller can't balance the free
 * base, so the robot face-plants under gravity (which is itself a fine physics
 * check). For a clean *standing* demo we can instead pin the free joint's qpos
 * to its initial value and zero its qvel each step — the legs/arms still respond
 * to PD + contact, but the pelvis stays put. The real policy (wbc-mjlab-5sq)
 * will keep it standing for real; this is only a presentation aid.
 *
 * Free joint layout: qpos[0..2]=pos, qpos[3..6]=quat(w,x,y,z); qvel[0..5]=twist.
 */
export interface BaseHold {
  apply(sim: MujocoSim): void;
}

export function makeBaseHold(sim: MujocoSim): BaseHold {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const qpos0: any = sim.data.qpos; // capture initial free-joint pose
  const init = [qpos0[0], qpos0[1], qpos0[2], qpos0[3], qpos0[4], qpos0[5], qpos0[6]];
  return {
    apply(s: MujocoSim): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qpos: any = s.data.qpos;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qvel: any = s.data.qvel;
      for (let i = 0; i < 7; i++) qpos[i] = init[i];
      for (let i = 0; i < 6; i++) qvel[i] = 0;
    },
  };
}
