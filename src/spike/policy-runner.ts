/**
 * onnxruntime-web policy runner (wasm backend, single-threaded).
 *
 * Ports `wbc-g1-deploy/include/isaaclab/algorithms/algorithms.h` (OrtRunner):
 * load `policy.onnx`, read its input/output shapes, and run obs → action each
 * control step.
 *
 * Threading: we force `numThreads = 1` so ORT uses the SIMD-but-single-thread
 * wasm build. That needs NO SharedArrayBuffer, so NO COOP/COEP headers — the
 * same constraint that kept the mujoco-wasm spike deployable on plain GitHub
 * Pages. The G1 actor is tiny (132→29 MLP); 50 Hz is comfortable single-threaded.
 */

import * as ort from 'onnxruntime-web';

// The ORT wasm runtime is served as a static asset from `public/ort/` (its npm
// `exports` field doesn't expose the wasm subpath to a Vite `?url` import). We
// copy `ort-wasm-simd-threaded.{wasm,mjs}` there and point ORT at that base.
const ORT_WASM_BASE = `${import.meta.env.BASE_URL}ort/`;

let configured = false;
function configureOrt(): void {
  if (configured) return;
  ort.env.wasm.numThreads = 1; // single-threaded → no SAB → no COOP/COEP
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  // Base URL ORT resolves its wasm/mjs runtime files against.
  ort.env.wasm.wasmPaths = ORT_WASM_BASE;
  configured = true;
}

export interface PolicyRunner {
  readonly inputName: string;
  readonly outputName: string;
  readonly obsDim: number; // input length we feed
  readonly actionDim: number; // verified output length
  /** Run inference. `obs.length` must equal obsDim. Returns a length-actionDim array. */
  act(obs: Float32Array): Promise<Float32Array>;
  dispose(): Promise<void>;
}

/**
 * Load + validate `policy.onnx`.
 *
 * ORT-web 1.20 exposes only input/output *names*, not declared shapes, so we
 * validate dims operationally: feed a `[1, expectedObsDim]` tensor and run once
 * with a zero obs. If the model's input width differs, `session.run` throws —
 * which we re-surface as a clear obs-dim mismatch. We then assert the output is
 * the expected (29-dim) action. This is exactly the parity check the milestone
 * calls for, just done at first run rather than from metadata.
 */
export async function loadPolicy(opts: {
  url: string;
  expectedObsDim: number;
  expectedActionDim: number;
}): Promise<PolicyRunner> {
  configureOrt();

  const session = await ort.InferenceSession.create(opts.url, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('policy: model has no input/output');
  }

  const obsDim = opts.expectedObsDim;

  async function run(obs: Float32Array): Promise<Float32Array> {
    const input = new ort.Tensor('float32', obs, [1, obsDim]);
    const feeds: Record<string, ort.Tensor> = {};
    feeds[inputName as string] = input;
    const out = await session.run(feeds);
    const result = out[outputName as string];
    if (!result) throw new Error(`policy: output "${outputName}" missing from run result`);
    return result.data as Float32Array;
  }

  // Validation pass with a zero obs — surfaces any input-width mismatch.
  let actionDim: number;
  try {
    const probe = await run(new Float32Array(obsDim));
    actionDim = probe.length;
  } catch (err) {
    throw new Error(
      `policy obs mismatch: feeding ${obsDim} dims to input "${inputName}" failed ` +
        `(${String(err)}). Check actor_observation_names order / term dims.`,
    );
  }
  if (actionDim !== opts.expectedActionDim) {
    throw new Error(
      `policy action mismatch: model output "${outputName}" is ${actionDim} dims ` +
        `but expected ${opts.expectedActionDim} (joint count).`,
    );
  }

  async function act(obs: Float32Array): Promise<Float32Array> {
    if (obs.length !== obsDim) {
      throw new Error(`policy.act: obs length ${obs.length} != ${obsDim}`);
    }
    return run(obs);
  }

  return {
    inputName: inputName as string,
    outputName: outputName as string,
    obsDim,
    actionDim,
    act,
    async dispose() {
      await session.release();
    },
  };
}
