/**
 * Fill Gen proprio terms from the live MuJoCo sim (same quantities as tracking).
 */

import type { MujocoSim } from './mujoco';
import type { GenDeployParams } from './gen-params';
import type { GenProprioSample } from './gen-obs-builder';

/** quat (w,x,y,z) conjugate applied to vector v. */
function quatConjApply(
  qw: number,
  qx: number,
  qy: number,
  qz: number,
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  const cx = -qx;
  const cy = -qy;
  const cz = -qz;
  const tx = 2 * (cy * vz - cz * vy);
  const ty = 2 * (cz * vx - cx * vz);
  const tz = 2 * (cx * vy - cy * vx);
  return [
    vx + qw * tx + (cy * tz - cz * ty),
    vy + qw * ty + (cz * tx - cx * tz),
    vz + qw * tz + (cx * ty - cy * tx),
  ];
}

interface GenJointMap {
  qAdr: Int32Array;
  vAdr: Int32Array;
}

function buildJointMap(sim: MujocoSim, jointNames: string[]): GenJointMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntQposAdr: any = sim.model.jnt_qposadr;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jntDofAdr: any = sim.model.jnt_dofadr;
  const jointNameToId = new Map<string, number>();
  for (let j = 0; j < (sim.model.njnt as number); j++) {
    const acc = sim.data.jnt(j);
    jointNameToId.set(acc.name, j);
    acc.delete();
  }
  const n = jointNames.length;
  const qAdr = new Int32Array(n);
  const vAdr = new Int32Array(n);
  for (let j = 0; j < n; j++) {
    const name = jointNames[j]!;
    const jid = jointNameToId.get(name);
    if (jid == null) throw new Error(`gen: MJCF has no joint "${name}"`);
    qAdr[j] = jntQposAdr[jid] as number;
    vAdr[j] = jntDofAdr[jid] as number;
  }
  return { qAdr, vAdr };
}

export interface GenProprioReader {
  sample(): GenProprioSample;
}

export function makeGenProprioReader(
  sim: MujocoSim,
  params: GenDeployParams,
  baseBodyId: number,
): GenProprioReader {
  const map = buildJointMap(sim, params.jointNames);
  const defaults = Float32Array.from(params.defaultJointPos);
  const n = params.jointNames.length;

  return {
    sample(): GenProprioSample {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qpos: any = sim.data.qpos;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qvel: any = sim.data.qvel;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const xquat: any = sim.data.xquat;

      const bq = baseBodyId * 4;
      const qw = xquat[bq] as number;
      const qx = xquat[bq + 1] as number;
      const qy = xquat[bq + 2] as number;
      const qz = xquat[bq + 3] as number;
      const [gx, gy, gz] = quatConjApply(qw, qx, qy, qz, 0, 0, -1);

      const baseAngVel = Float32Array.from([
        qvel[3] as number,
        qvel[4] as number,
        qvel[5] as number,
      ]);
      const projectedGravity = Float32Array.from([gx, gy, gz]);
      const jointPosRel = new Float32Array(n);
      const jointVelRel = new Float32Array(n);
      for (let j = 0; j < n; j++) {
        jointPosRel[j] = (qpos[map.qAdr[j]!] as number) - defaults[j]!;
        jointVelRel[j] = qvel[map.vAdr[j]!] as number;
      }

      const out: GenProprioSample = {
        base_ang_vel: baseAngVel,
        projected_gravity: projectedGravity,
        joint_pos_rel: jointPosRel,
        joint_vel_rel: jointVelRel,
      };
      // Optional torque term (torques overlay); leave zeros if requested.
      if (params.stateObservationNames.includes('joint_torque')) {
        out.joint_torque = new Float32Array(n);
      }
      return out;
    },
  };
}
