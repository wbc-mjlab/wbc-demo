/**
 * Browser port of deploy `GenReferenceEngine`: proprio hist + vel cmds → Arc 39.
 */

import {
  clamp,
  loadGenDeployParams,
  playRange,
  resolveGeneratorOnnxUrl,
  type GenDeployParams,
} from './gen-params';
import { GenObsBuilder, standingProprioSample, type GenProprioSample } from './gen-obs-builder';
import { loadPolicy, type PolicyRunner } from './policy-runner';

export interface GenReferenceEngine {
  readonly params: GenDeployParams;
  reset(): void;
  pushProprio(sample: GenProprioSample): void;
  setHeightCmd(heightM: number): void;
  seedHeight(heightM: number): void;
  heightCmd(): number;
  historyReady(): boolean;
  /** One Gen step → Arc length `outputDim` (39). */
  step(vx: number, vy: number, wz: number): Promise<Float32Array>;
  dispose(): Promise<void>;
}

export async function createGenReferenceEngine(
  paramsBaseUrl: string,
): Promise<GenReferenceEngine> {
  const params = await loadGenDeployParams(paramsBaseUrl);
  const obs = new GenObsBuilder(params);
  const runner: PolicyRunner = await loadPolicy({
    url: resolveGeneratorOnnxUrl(params),
    expectedObsDim: params.inputDim,
    expectedActionDim: params.outputDim,
  });

  return {
    params,
    reset() {
      obs.reset(standingProprioSample(params));
    },
    pushProprio(sample) {
      obs.push(sample);
    },
    setHeightCmd(heightM) {
      const [lo, hi] = playRange(params, 'height', [0.75, 0.85]);
      obs.setHeightCmd(clamp(heightM, lo, hi));
    },
    seedHeight(heightM) {
      const [lo, hi] = playRange(params, 'height', [0.75, 0.85]);
      obs.seedHeight(clamp(heightM, lo, hi));
    },
    heightCmd() {
      return obs.getHeightCmd();
    },
    historyReady() {
      return obs.isHistoryReady();
    },
    async step(vx, vy, wz) {
      if (!obs.isHistoryReady()) throw new Error('Gen history not ready');
      const flat = obs.buildObs(vx, vy, wz);
      const out = await runner.act(flat);
      if (out.length !== params.outputDim) {
        throw new Error(`Gen ONNX output dim ${out.length} != ${params.outputDim}`);
      }
      return out;
    },
    async dispose() {
      await runner.dispose();
    },
  };
}
