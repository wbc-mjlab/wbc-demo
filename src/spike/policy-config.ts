/**
 * Deploy policy config + reference-stream loaders for the live WBC engine.
 *
 * Ports the parts of `wbc-g1-deploy` that parse the exported tracking config
 * (`config.yaml`, schema `wbc_tracking_params_v1`) and read the per-clip
 * reference stream (`reference/*.bin`, schema `wbc_reference_stream_v1`).
 *
 * The config defines the policy contract:
 *   - `joint_names`            — the 29-joint order (== MJCF joint/actuator order)
 *   - `default_joint_pos`      — reference default pose (rad), joint_names order
 *   - `stiffness` / `damping`  — per-joint PD gains the trained IdealPdActuator used
 *   - `action.scale`           — per-joint residual scale (reference_residual)
 *   - `actor_observation_names`— obs term order; we concat in this order
 *   - per-term `scale`         — applied to each obs term (all 1.0 for this policy)
 *
 * See `wbc-g1-deploy/src/wbc_tracking_params.cpp` (config → deploy translation),
 * `WbcMotionLoader.cpp` (reference stream math) and this repo's
 * `REFERENCE_STREAM.md` for the authoritative definitions.
 */

import { load as yamlLoad } from 'js-yaml';

/** A single observation term: name (training name) + per-element scale. */
export interface ObsTerm {
  name: string;
  dim: number;
  scale: number[];
}

/** Parsed deploy policy config (`wbc_tracking_params_v1`). */
export interface PolicyConfig {
  robotId: string;
  policyStepDt: number; // control period, s (0.02 == 50 Hz)
  jointNames: string[]; // 29, == MJCF joint order
  defaultJointPos: number[]; // 29, reference default pose (rad)
  stiffness: number[]; // 29, PD kp per joint
  damping: number[]; // 29, PD kd per joint
  actionMode: string; // "reference_residual"
  actionScale: number[]; // 29, residual scale
  anchorBody: string; // "torso_link"
  /** actor_observation_names order, with per-term dim+scale. */
  obsTerms: ObsTerm[];
  /** reference_observation_names — the prefix that comes from the .bin stream. */
  referenceObsNames: string[];
  actorHistoryLength: number;
  /** sum of obsTerms dims (== ONNX input length). */
  obsDim: number;
}

/** Reference-stream index (`reference/index.json`, `wbc_reference_stream_v1`). */
export interface ReferenceIndex {
  schema: string;
  robot: string;
  commandDim: number; // 39 for G1
  fps: number; // 50.0
  refTerms: Array<{ name: string; dim: number }>;
  clips: ReferenceClip[];
}

export interface ReferenceClip {
  id: string;
  name: string;
  file: string;
  frames: number;
  durationSec: number;
  tags?: string[];
}

/** Names the deploy treats as reference (sourced from the .bin), not live proprio. */
const REFERENCE_TERM_NAMES = new Set([
  'ref_base_height',
  'ref_base_lin_vel_b',
  'ref_base_ang_vel_b',
  'ref_gravity_b',
  'ref_joint_pos',
  'ref_joint_vel',
]);

export function isReferenceObsName(name: string): boolean {
  return name === 'command' || REFERENCE_TERM_NAMES.has(name);
}

/**
 * Parse `config.yaml` (the `wbc_tracking_params_v1` export) into a PolicyConfig.
 * The leading `# …` comment line is tolerated by js-yaml.
 */
export function parsePolicyConfig(text: string): PolicyConfig {
  const doc = yamlLoad(text) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') {
    throw new Error('policy config: not a YAML mapping');
  }

  const tracking = (doc.tracking ?? {}) as Record<string, unknown>;
  const action = (doc.action ?? {}) as Record<string, unknown>;
  const actorObs = (doc.actor_observations ?? {}) as Record<string, Record<string, unknown>>;

  const order = (tracking.actor_observation_names as string[]) ?? Object.keys(actorObs);
  const referenceObsNames =
    (tracking.reference_observation_names as string[]) ??
    order.filter(isReferenceObsName);

  const obsTerms: ObsTerm[] = order.map((name) => {
    const block = actorObs[name];
    if (!block) throw new Error(`policy config: actor_observations missing term "${name}"`);
    const dim = Number(block.dim);
    const scale = (block.scale as number[]) ?? new Array(dim).fill(1.0);
    if (scale.length !== dim) {
      throw new Error(
        `policy config: term "${name}" scale length ${scale.length} != dim ${dim}`,
      );
    }
    return { name, dim, scale };
  });

  const obsDim = obsTerms.reduce((s, t) => s + t.dim, 0);

  return {
    robotId: String(doc.robot_id ?? 'g1'),
    policyStepDt: Number(doc.policy_step_dt ?? 0.02),
    jointNames: doc.joint_names as string[],
    defaultJointPos: doc.default_joint_pos as number[],
    stiffness: doc.stiffness as number[],
    damping: doc.damping as number[],
    actionMode: String(action.action_mode ?? 'reference_residual'),
    actionScale: action.scale as number[],
    anchorBody: String(tracking.anchor_body_name ?? 'torso_link'),
    obsTerms,
    referenceObsNames,
    actorHistoryLength: Number(tracking.actor_history_length ?? 1),
    obsDim,
  };
}

/** Fetch + parse the policy config YAML. */
export async function loadPolicyConfig(url: string): Promise<PolicyConfig> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return parsePolicyConfig(await res.text());
}

/** Fetch + parse the reference index JSON. */
export async function loadReferenceIndex(url: string): Promise<ReferenceIndex> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  const idx = (await res.json()) as ReferenceIndex;
  if (idx.schema !== 'wbc_reference_stream_v1') {
    throw new Error(`reference index: unexpected schema "${idx.schema}"`);
  }
  return idx;
}

/**
 * A loaded reference clip: the raw float32 stream, frame-major
 * `frames × commandDim`. Mirrors deploy's `WbcMotionLoader` but the math is
 * pre-baked, so we just index by frame.
 */
export class ReferenceStream {
  readonly frames: number;
  readonly commandDim: number;
  private readonly data: Float32Array;

  constructor(buffer: ArrayBuffer, commandDim: number) {
    this.data = new Float32Array(buffer);
    this.commandDim = commandDim;
    this.frames = this.data.length / commandDim;
    if (!Number.isInteger(this.frames)) {
      throw new Error(
        `reference stream: byteLength ${buffer.byteLength} not a multiple of ` +
          `commandDim ${commandDim} * 4`,
      );
    }
  }

  /** The 39-vector for frame `i` (clamped to range). */
  frame(i: number): Float32Array {
    const f = Math.max(0, Math.min(i, this.frames - 1));
    return this.data.subarray(f * this.commandDim, (f + 1) * this.commandDim);
  }
}

/** Fetch a reference clip `.bin` and wrap it. */
export async function loadReferenceStream(
  url: string,
  commandDim: number,
): Promise<ReferenceStream> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return new ReferenceStream(await res.arrayBuffer(), commandDim);
}
