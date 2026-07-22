/**
 * Load wbc_gen_deploy_params_v1 (deploy config/policy/gen/<overlay>/params/config.yaml).
 */

import { load as yamlLoad } from 'js-yaml';

export interface GenStateTermCfg {
  deployName: string;
  trainingName: string;
  dim: number;
  historyLength: number;
  flatWidth: number;
  scale: number[];
}

export interface GenCommandCfg {
  packing: string;
  horizons: number[];
  positionScale: number;
  xyFeaturesPerHorizon: number;
  heightFeaturesPerHorizon: number;
  heightSetpointDim: number;
  angleFeaturesPerHorizon: number;
  heightLowpassTau: number;
  heightScale: number;
}

export interface GenModelCfg {
  onnxFile: string;
  onnxInputName: string;
  onnxOutputName: string;
  type: string;
}

export interface GenDeployParams {
  schemaVersion: string;
  robotId: string;
  overlay: string;
  stepDt: number;
  jointNames: string[];
  jointIdsMap: number[];
  defaultJointPos: number[];
  stateObservationNames: string[];
  stateObservations: Record<string, GenStateTermCfg>;
  historyLength: number;
  command: GenCommandCfg;
  inputDim: number;
  stateDim: number;
  commandDim: number;
  outputDim: number;
  model: GenModelCfg;
  playVelRanges: Record<string, [number, number]>;
  /** Absolute URL of the params folder (trailing slash). */
  paramsBaseUrl: string;
}

function asFloatList(raw: unknown, fallbackDim: number): number[] {
  if (raw == null) return Array.from({ length: Math.max(fallbackDim, 0) }, () => 1);
  if (Array.isArray(raw)) return raw.map((v) => Number(v));
  return Array.from({ length: Math.max(fallbackDim, 1) }, () => Number(raw));
}

function asStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => String(v));
}

function asNumberList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((v) => Number(v));
}

/** Fetch + parse params/config.yaml. paramsBaseUrl should end with a slash. */
export async function loadGenDeployParams(paramsBaseUrl: string): Promise<GenDeployParams> {
  const base = paramsBaseUrl.endsWith('/') ? paramsBaseUrl : `${paramsBaseUrl}/`;
  const res = await fetch(`${base}config.yaml`);
  if (!res.ok) throw new Error(`gen params: HTTP ${res.status} for ${base}config.yaml`);
  const doc = yamlLoad(await res.text()) as Record<string, unknown>;

  const schemaVersion = String(doc.schema_version ?? '');
  if (schemaVersion !== 'wbc_gen_deploy_params_v1') {
    throw new Error(`Expected wbc_gen_deploy_params_v1, got '${schemaVersion}'`);
  }

  const state = doc.state as Record<string, unknown> | undefined;
  if (!state) throw new Error('Gen params missing state block');
  const observationNames = asStringList(state.observation_names);
  const observations = (state.observations ?? {}) as Record<string, Record<string, unknown>>;
  const historyLength = Number(state.history_length ?? 1);

  const stateObservations: Record<string, GenStateTermCfg> = {};
  for (const name of observationNames) {
    const term = observations[name];
    if (!term) throw new Error(`Gen params missing state.observations.${name}`);
    const dim = Number(term.dim);
    const hist = Number(term.history_length ?? historyLength);
    stateObservations[name] = {
      deployName: name,
      trainingName: String(term.training_name ?? name),
      dim,
      historyLength: hist,
      flatWidth: Number(term.flat_width ?? dim * hist),
      scale: asFloatList(term.scale, dim),
    };
  }

  const cmd = doc.command as Record<string, unknown> | undefined;
  if (!cmd) throw new Error('Gen params missing command block');

  const dims = doc.dims as Record<string, unknown> | undefined;
  if (!dims) throw new Error('Gen params missing dims block');

  const modelRaw = (doc.model ?? {}) as Record<string, unknown>;
  const playRaw = (doc.play_vel_ranges ?? {}) as Record<string, unknown>;
  const playVelRanges: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(playRaw)) {
    if (!Array.isArray(v) || v.length < 2) continue;
    playVelRanges[k] = [Number(v[0]), Number(v[1])];
  }

  return {
    schemaVersion,
    robotId: String(doc.robot_id ?? 'g1'),
    overlay: String(doc.overlay ?? ''),
    stepDt: Number(doc.step_dt ?? 0.02),
    jointNames: asStringList(doc.joint_names),
    jointIdsMap: asNumberList(doc.joint_ids_map),
    defaultJointPos: asNumberList(doc.default_joint_pos),
    stateObservationNames: observationNames,
    stateObservations,
    historyLength,
    command: {
      packing: String(cmd.packing ?? 'xy_then_height_then_angle'),
      horizons: asNumberList(cmd.horizons),
      positionScale: Number(cmd.position_scale ?? 1),
      xyFeaturesPerHorizon: Number(cmd.xy_features_per_horizon ?? 2),
      heightFeaturesPerHorizon: Number(cmd.height_features_per_horizon ?? 0),
      heightSetpointDim: Number(cmd.height_setpoint_dim ?? 0),
      angleFeaturesPerHorizon: Number(cmd.angle_features_per_horizon ?? 2),
      heightLowpassTau: Number(cmd.height_lowpass_tau ?? 0.1),
      heightScale: Number(cmd.height_scale ?? 1),
    },
    inputDim: Number(dims.input_dim),
    stateDim: Number(dims.state_dim),
    commandDim: Number(dims.command_dim),
    outputDim: Number(dims.output_dim ?? 39),
    model: {
      type: String(modelRaw.type ?? ''),
      onnxFile: String(modelRaw.onnx_file ?? 'generator.onnx'),
      onnxInputName: String(modelRaw.onnx_input_name ?? 'obs'),
      onnxOutputName: String(modelRaw.onnx_output_name ?? 'reference'),
    },
    playVelRanges,
    paramsBaseUrl: base,
  };
}

export function resolveGeneratorOnnxUrl(params: GenDeployParams): string {
  return `${params.paramsBaseUrl}${params.model.onnxFile}`;
}

export function playRange(
  params: GenDeployParams,
  key: string,
  fallback: [number, number],
): [number, number] {
  return params.playVelRanges[key] ?? fallback;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
