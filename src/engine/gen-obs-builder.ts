/**
 * History rings + flat state ‖ command packing for `generator.onnx`.
 * Port of deploy `GenObsBuilder`.
 */

import type { GenDeployParams } from './gen-params';
import { clamp, playRange } from './gen-params';
import {
  integrateVelToSparseWaypoints,
  lowpassHeightWaypoints,
  packCommandXyHeightAngle,
} from './gen-waypoints';

export type GenProprioSample = Record<string, Float32Array>;

function defaultStandHeight(params: GenDeployParams): number {
  const [lo, hi] = playRange(params, 'height', [0.75, 0.85]);
  return clamp(0.8, lo, hi);
}

function zeroTerm(dim: number, name: string): Float32Array {
  if (name === 'projected_gravity' && dim >= 3) {
    return Float32Array.from([0, 0, -1]);
  }
  return new Float32Array(Math.max(dim, 0));
}

export function standingProprioSample(params: GenDeployParams): GenProprioSample {
  const s: GenProprioSample = {};
  for (const name of params.stateObservationNames) {
    const cfg = params.stateObservations[name]!;
    s[name] = zeroTerm(cfg.dim, name);
  }
  return s;
}

export class GenObsBuilder {
  private readonly rings = new Map<string, Float32Array[]>();
  private historyReady = false;
  private heightCmd = 0.8;
  private heightWp = new Float32Array(0);

  constructor(private readonly params: GenDeployParams) {
    for (const name of params.stateObservationNames) this.rings.set(name, []);
    this.seedHeight(defaultStandHeight(params));
    this.reset(standingProprioSample(params));
  }

  seedHeight(height: number): void {
    this.heightCmd = height;
    if (this.params.command.heightSetpointDim > 0) {
      this.heightWp = new Float32Array([height]);
      return;
    }
    const k = this.params.command.horizons.length;
    this.heightWp = new Float32Array(Math.max(k, 0));
    this.heightWp.fill(height);
  }

  setHeightCmd(heightCmd: number): void {
    this.heightCmd = heightCmd;
  }

  getHeightCmd(): number {
    return this.heightCmd;
  }

  isHistoryReady(): boolean {
    return this.historyReady;
  }

  reset(fill: GenProprioSample): void {
    for (const name of this.params.stateObservationNames) {
      const cfg = this.params.stateObservations[name]!;
      const vals = fill[name];
      if (!vals) throw new Error(`Proprio sample missing term: ${name}`);
      if (vals.length !== cfg.dim) {
        throw new Error(`Proprio term ${name} dim ${vals.length} != ${cfg.dim}`);
      }
      const ring: Float32Array[] = [];
      for (let i = 0; i < cfg.historyLength; i++) ring.push(new Float32Array(vals));
      this.rings.set(name, ring);
    }
    this.historyReady = true;
    this.seedHeight(defaultStandHeight(this.params));
  }

  push(sample: GenProprioSample): void {
    for (const name of this.params.stateObservationNames) {
      const cfg = this.params.stateObservations[name]!;
      const src = sample[name];
      if (!src) throw new Error(`Proprio sample missing term: ${name}`);
      if (src.length !== cfg.dim) throw new Error(`Proprio term ${name} dim mismatch on push`);
      const vals = new Float32Array(src);
      for (let i = 0; i < vals.length && i < cfg.scale.length; i++) {
        vals[i]! *= cfg.scale[i]!;
      }
      const ring = this.rings.get(name)!;
      ring.push(vals);
      while (ring.length > cfg.historyLength) ring.shift();
    }
    this.historyReady = true;
    for (const name of this.params.stateObservationNames) {
      const cfg = this.params.stateObservations[name]!;
      if ((this.rings.get(name)?.length ?? 0) < cfg.historyLength) {
        this.historyReady = false;
        break;
      }
    }
  }

  buildObs(vx: number, vy: number, wz: number): Float32Array {
    const obs = new Float32Array(this.params.inputDim);
    let k = 0;
    for (const name of this.params.stateObservationNames) {
      const cfg = this.params.stateObservations[name]!;
      const ring = this.rings.get(name)!;
      if (ring.length !== cfg.historyLength) {
        throw new Error(`History not ready for term ${name}`);
      }
      for (const frame of ring) {
        obs.set(frame, k);
        k += frame.length;
      }
    }

    const { xy, ang } = integrateVelToSparseWaypoints(
      vx,
      vy,
      wz,
      this.params.command.horizons,
      this.params.stepDt,
      this.params.command.positionScale,
    );

    let height = new Float32Array(0);
    const scale = this.params.command.heightScale;
    if (!(scale > 0)) throw new Error('command.height_scale must be positive');
    if (this.params.command.heightSetpointDim > 0) {
      height = new Float32Array(this.params.command.heightSetpointDim);
      height.fill(this.heightCmd / scale);
    } else if (this.params.command.heightFeaturesPerHorizon > 0) {
      if (this.heightWp.length !== this.params.command.horizons.length) {
        this.seedHeight(this.heightCmd);
      }
      lowpassHeightWaypoints(
        this.heightWp,
        this.heightCmd,
        this.params.stepDt,
        this.params.command.horizons,
        this.params.command.heightLowpassTau,
      );
      height = new Float32Array(this.heightWp.length);
      for (let i = 0; i < this.heightWp.length; i++) {
        height[i] = this.heightWp[i]! / scale;
      }
    }

    const cmd = packCommandXyHeightAngle(xy, height, ang);
    obs.set(cmd, k);
    k += cmd.length;
    if (k !== this.params.inputDim) {
      throw new Error(`Built obs dim ${k} != input_dim ${this.params.inputDim}`);
    }
    return obs;
  }
}
