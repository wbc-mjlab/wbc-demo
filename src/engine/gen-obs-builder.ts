/**
 * History rings + flat state ‖ command (term_names order) for `generator.onnx`.
 * Port of deploy `GenObsBuilder`.
 */

import type { GenDeployParams } from './gen-params';
import { clamp, playRange } from './gen-params';
import {
  applyIdleDeadzone,
  FALLEN_GRAVITY_Z,
  integrateVelToSparseWaypoints,
  lowpassFirstOrder,
  lowpassHeightWaypoints,
} from './gen-waypoints';

export type GenProprioSample = Record<string, Float32Array>;

function styleHeightDeploy(params: GenDeployParams, name: string): number {
  const range = params.command.styleHeightRanges[name];
  const lo = range?.[0] ?? 0;
  const hi = range?.[1] ?? 1;
  // Prefer the exported per-style command (median clip height for that style).
  // The envelope midpoint is only a fallback for older configs: the `sit`
  // envelope spans standing-to-floor because the sitting clips include
  // start/stop transitions, so its midpoint is nowhere near a seated pose.
  const measured = params.command.styleHeightDeploy[name];
  if (measured != null && Number.isFinite(measured)) {
    return clamp(measured, lo, hi);
  }
  const mid = 0.5 * (lo + hi);
  const preferred = name === 'stand_walk' ? 0.81 : mid;
  return clamp(preferred, lo, hi);
}

function defaultStandHeight(params: GenDeployParams): number {
  const preferred = styleHeightDeploy(params, 'stand_walk');
  const [lo, hi] = playRange(params, 'height', [0.65, 0.85]);
  return clamp(preferred, lo, hi);
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
  private heightCmd = 0.81;
  private heightWp = new Float32Array(0);
  private styleIndex = 0;
  private velSmooth = { vx: 0, vy: 0, wz: 0 };
  private lastGz = -1;
  private fallenHold = 0;

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

  hasStyle(): boolean {
    return this.params.command.styleDim > 0;
  }

  getStyleIndex(): number {
    return this.styleIndex;
  }

  setStyle(style: number | string): void {
    if (this.params.command.styleDim <= 0) return;
    if (typeof style === 'string') {
      const idx = this.params.command.styleNames.indexOf(style);
      if (idx < 0) throw new Error(`Unknown locomotion style: ${style}`);
      this.styleIndex = idx;
    } else {
      this.styleIndex = clamp(
        Math.trunc(style),
        0,
        this.params.command.styleDim - 1,
      );
    }
  }

  setStyleAndHeight(style: number | string): void {
    this.setStyle(style);
    if (!this.hasStyle()) return;
    const name = this.params.command.styleNames[this.styleIndex];
    if (!name) return;
    const range = this.params.command.styleHeightRanges[name];
    if (!range) return;
    this.seedHeight(styleHeightDeploy(this.params, name));
  }

  isHistoryReady(): boolean {
    return this.historyReady;
  }

  isFallen(): boolean {
    return this.lastGz > FALLEN_GRAVITY_Z;
  }

  getFallenHold(): number {
    return this.fallenHold;
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
    this.velSmooth = { vx: 0, vy: 0, wz: 0 };
    this.lastGz = -1;
    this.fallenHold = 0;
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
    const grav = sample.projected_gravity;
    if (grav && grav.length >= 3) {
      this.lastGz = grav[2]!;
      this.fallenHold = this.lastGz > FALLEN_GRAVITY_Z ? this.fallenHold + 1 : 0;
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
    const dt = this.params.stepDt;
    const tau = this.params.command.commandSmoothingTau;
    this.velSmooth.vx = lowpassFirstOrder(this.velSmooth.vx, vx, dt, tau);
    this.velSmooth.vy = lowpassFirstOrder(this.velSmooth.vy, vy, dt, tau);
    this.velSmooth.wz = lowpassFirstOrder(this.velSmooth.wz, wz, dt, tau);

    let { vx: vxCmd, vy: vyCmd, wz: wzCmd } = applyIdleDeadzone(
      this.velSmooth.vx,
      this.velSmooth.vy,
      this.velSmooth.wz,
    );
    // Down: hold still and let the generator get itself up. Recovery has no
    // command channel — the network reads "I am on the ground" out of proprio,
    // so nothing style- or height-specific is needed here.
    if (this.isFallen()) {
      vxCmd = 0;
      vyCmd = 0;
      wzCmd = 0;
      this.velSmooth = { vx: 0, vy: 0, wz: 0 };
      this.seedHeight(defaultStandHeight(this.params));
    }

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

    const horizons = this.params.command.horizons;
    const { xy, ang } = integrateVelToSparseWaypoints(
      vxCmd,
      vyCmd,
      wzCmd,
      horizons,
      this.params.stepDt,
      this.params.command.positionScale,
    );

    const scale = this.params.command.heightScale;
    if (!(scale > 0)) throw new Error('command.height_scale must be positive');

    for (const name of this.params.command.termNames) {
      const term = this.params.command.observations[name];
      if (!term) throw new Error(`Missing command observation ${name}`);
      let block: Float32Array;
      if (name === 'cmd_style') {
        block = new Float32Array(term.flatWidth);
        const idx = this.isFallen()
          ? 0
          : clamp(this.styleIndex, 0, Math.max(term.flatWidth - 1, 0));
        if (term.flatWidth > 0) block[idx] = 1;
      } else if (name === 'cmd_xy_waypoints') {
        block = xy;
      } else if (name === 'cmd_angle_waypoints') {
        block = ang;
      } else if (name === 'cmd_height_setpoint') {
        block = new Float32Array(term.flatWidth);
        block.fill(this.heightCmd / scale);
      } else if (name === 'cmd_height_waypoints') {
        if (this.heightWp.length !== horizons.length) {
          this.seedHeight(this.heightCmd);
        }
        lowpassHeightWaypoints(
          this.heightWp,
          this.heightCmd,
          this.params.stepDt,
          horizons,
          this.params.command.heightLowpassTau,
        );
        block = new Float32Array(this.heightWp.length);
        for (let i = 0; i < this.heightWp.length; i++) {
          block[i] = this.heightWp[i]! / scale;
        }
      } else if (name.startsWith('cmd_future_')) {
        // Teleop does not synthesize future-Arc fields; zeros keep dim layout.
        block = new Float32Array(term.flatWidth);
      } else {
        throw new Error(`Unsupported command term for teleop packing: ${name}`);
      }
      if (block.length !== term.flatWidth) {
        throw new Error(
          `Command term ${name} width ${block.length} != flat_width ${term.flatWidth}`,
        );
      }
      obs.set(block, k);
      k += block.length;
    }

    if (k !== this.params.inputDim) {
      throw new Error(`Built obs dim ${k} != input_dim ${this.params.inputDim}`);
    }
    return obs;
  }
}
