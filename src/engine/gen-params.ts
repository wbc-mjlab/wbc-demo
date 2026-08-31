/**
 * Load Gen deploy params (``wbc_gen_deploy_params_v2``).
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

export interface GenCommandTermCfg {
  deployName: string;
  trainingName: string;
  dim: number;
  historyLength: number;
  flatWidth: number;
  scale: number[];
  horizons?: number[];
  positionScale?: number;
  heightScale?: number;
  heightLowpassTau?: number;
  heightSetpointDim?: number;
  featuresPerHorizon?: number;
  styleNames?: string[];
  styleHeightRanges?: Record<string, [number, number]>;
  /**
   * Per-style height command, measured from the training motion library.
   * Prefer this over the midpoint of `styleHeightRanges`: the `sit` envelope
   * spans standing-to-floor because the sitting clips include start/stop
   * transitions, so its midpoint is not a seated pose.
   */
  styleHeightDeploy?: Record<string, number>;
}

export interface GenCommandCfg {
  termNames: string[];
  observations: Record<string, GenCommandTermCfg>;
  horizons: number[];
  positionScale: number;
  heightScale: number;
  heightLowpassTau: number;
  /** Low-pass time constant for teleop ``[vx, vy, wz]`` before waypoints. */
  commandSmoothingTau: number;
  /** Derived convenience for teleop (0 = no setpoint term). */
  heightSetpointDim: number;
  /** Derived convenience for teleop (0 = no per-horizon height). */
  heightFeaturesPerHorizon: number;
  /** Style one-hot dim (0 = no ``cmd_style``). */
  styleDim: number;
  styleNames: string[];
  styleHeightRanges: Record<string, [number, number]>;
  styleHeightDeploy: Record<string, number>;
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

function parseCommandTerm(
  name: string,
  term: Record<string, unknown>,
): GenCommandTermCfg {
  const dim = Number(term.dim);
  const hist = Number(term.history_length ?? 0);
  const cfg: GenCommandTermCfg = {
    deployName: String(term.deploy_name ?? name),
    trainingName: String(term.training_name ?? name),
    dim,
    historyLength: hist,
    flatWidth: Number(term.flat_width ?? dim),
    scale: asFloatList(term.scale, dim),
  };
  if (term.horizons != null) cfg.horizons = asNumberList(term.horizons);
  if (term.position_scale != null) cfg.positionScale = Number(term.position_scale);
  if (term.height_scale != null) cfg.heightScale = Number(term.height_scale);
  if (term.height_lowpass_tau != null) {
    cfg.heightLowpassTau = Number(term.height_lowpass_tau);
  }
  if (term.height_setpoint_dim != null) {
    cfg.heightSetpointDim = Number(term.height_setpoint_dim);
  }
  if (term.features_per_horizon != null) {
    cfg.featuresPerHorizon = Number(term.features_per_horizon);
  }
  if (Array.isArray(term.style_names)) {
    cfg.styleNames = asStringList(term.style_names);
  }
  if (term.style_height_ranges && typeof term.style_height_ranges === 'object') {
    const ranges: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(
      term.style_height_ranges as Record<string, unknown>,
    )) {
      if (!Array.isArray(v) || v.length < 2) continue;
      ranges[k] = [Number(v[0]), Number(v[1])];
    }
    cfg.styleHeightRanges = ranges;
  }
  if (term.style_height_deploy && typeof term.style_height_deploy === 'object') {
    const deploy: Record<string, number> = {};
    for (const [k, v] of Object.entries(
      term.style_height_deploy as Record<string, unknown>,
    )) {
      deploy[k] = Number(v);
    }
    cfg.styleHeightDeploy = deploy;
  }
  return cfg;
}

function parseModularCommand(cmd: Record<string, unknown>): GenCommandCfg {
  const termNames = asStringList(cmd.term_names);
  if (termNames.length === 0) {
    throw new Error('Gen params command missing term_names');
  }
  const rawObs = (cmd.observations ?? {}) as Record<string, Record<string, unknown>>;
  const observations: Record<string, GenCommandTermCfg> = {};
  for (const name of termNames) {
    const term = rawObs[name];
    if (!term) throw new Error(`Gen params missing command.observations.${name}`);
    observations[name] = parseCommandTerm(name, term);
  }

  const xy = observations['cmd_xy_waypoints'];
  const hSet = observations['cmd_height_setpoint'];
  const hWp = observations['cmd_height_waypoints'];
  const style = observations['cmd_style'];
  const horizons =
    asNumberList(cmd.horizons).length > 0
      ? asNumberList(cmd.horizons)
      : (xy?.horizons ?? hWp?.horizons ?? []);

  const defaultStyleNames = ['stand_walk', 'crouch', 'run', 'sit'];
  const styleDim = style?.flatWidth ?? 0;
  let styleNames = style?.styleNames ?? [];
  if (styleNames.length === 0 && styleDim > 0) {
    styleNames = defaultStyleNames.slice(0, styleDim);
  }

  return {
    termNames,
    observations,
    horizons,
    positionScale: xy?.positionScale ?? 1,
    heightScale: hSet?.heightScale ?? hWp?.heightScale ?? 1,
    heightLowpassTau: hWp?.heightLowpassTau ?? 0,
    commandSmoothingTau: Number(cmd.command_smoothing_tau ?? 0.1),
    heightSetpointDim: hSet?.flatWidth ?? hSet?.heightSetpointDim ?? 0,
    heightFeaturesPerHorizon: hWp != null ? (hWp.featuresPerHorizon ?? 1) : 0,
    styleDim,
    styleNames,
    styleHeightRanges: style?.styleHeightRanges ?? {},
    styleHeightDeploy: style?.styleHeightDeploy ?? {},
  };
}

/** Fetch + parse params/config.yaml. paramsBaseUrl should end with a slash. */
export async function loadGenDeployParams(paramsBaseUrl: string): Promise<GenDeployParams> {
  const base = paramsBaseUrl.endsWith('/') ? paramsBaseUrl : `${paramsBaseUrl}/`;
  const res = await fetch(`${base}config.yaml`);
  if (!res.ok) throw new Error(`gen params: HTTP ${res.status} for ${base}config.yaml`);
  const doc = yamlLoad(await res.text()) as Record<string, unknown>;

  const schemaVersion = String(doc.schema_version ?? '');
  if (schemaVersion !== 'wbc_gen_deploy_params_v2') {
    throw new Error(`Expected wbc_gen_deploy_params_v2, got '${schemaVersion}'`);
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
  if (cmd.observations == null) {
    throw new Error('Gen params command missing observations (v2 modular layout required)');
  }

  const dims = doc.dims as Record<string, unknown> | undefined;
  if (!dims) throw new Error('Gen params missing dims block');

  const command = parseModularCommand(cmd);

  let cmdSum = 0;
  for (const name of command.termNames) {
    cmdSum += command.observations[name]!.flatWidth;
  }
  const commandDim = Number(dims.command_dim);
  if (cmdSum !== commandDim) {
    throw new Error(
      `Gen params command flat widths sum ${cmdSum} != command_dim ${commandDim}`,
    );
  }

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
    command,
    inputDim: Number(dims.input_dim),
    stateDim: Number(dims.state_dim),
    commandDim,
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
