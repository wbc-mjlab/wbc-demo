/**
 * Thin wrapper around the official DeepMind MuJoCo WASM bindings
 * (`@mujoco/mujoco`, single-threaded build).
 *
 * Loads the Unitree G1 MJCF + STL meshes into the Emscripten virtual
 * filesystem, compiles the model, and steps physics in the browser. The live
 * engine (`live-engine.ts`) drives it; the renderer reads its body transforms.
 *
 * Why the single-threaded build: it needs NO COOP/COEP headers, so it works on
 * plain GitHub Pages. The `@mujoco/mujoco/mt` build is faster but requires
 * cross-origin isolation (SharedArrayBuffer); the tiny G1 actor doesn't need it.
 */

import loadMujoco from '@mujoco/mujoco';
// Vite resolves this `?url` import to the emitted, hashed wasm asset URL so the
// Emscripten loader can fetch it at runtime instead of guessing a path.
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

import type { MainModule, MjModel, MjData } from '@mujoco/mujoco';

/** A compiled, ready-to-step G1 simulation plus the module that owns it. */
export interface MujocoSim {
  readonly mujoco: MainModule;
  readonly model: MjModel;
  readonly data: MjData;
  /** Number of bodies including the world body at index 0. */
  readonly nbody: number;
  /** Generalised coordinate / velocity sizes. */
  readonly nq: number;
  readonly nv: number;
  readonly nu: number;
  /** Simulation timestep (seconds) read from the compiled model. */
  readonly timestep: number;
  /** Map body name → MuJoCo body id, for binding to the GLB. */
  readonly bodyNameToId: Map<string, number>;
}

let modulePromise: Promise<MainModule> | null = null;

/**
 * Load and cache the MuJoCo WASM module. Emscripten's `locateFile` is pointed
 * at the Vite-resolved wasm URL so it loads regardless of base path.
 */
export async function getMujoco(): Promise<MainModule> {
  if (!modulePromise) {
    modulePromise = loadMujoco({
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path),
    } as unknown as Record<string, unknown>) as Promise<MainModule>;
  }
  return modulePromise;
}

/** A single asset to drop into the Emscripten virtual FS before compiling. */
export interface VfsFile {
  /** Path inside the WASM FS, e.g. `/work/scene_g1.xml` or `/work/assets/foo.STL`. */
  path: string;
  data: Uint8Array | string;
}

/**
 * Fetch the MJCF scene + every referenced mesh, write them into the Emscripten
 * MEMFS under a working dir, then compile + instantiate the model.
 *
 * `meshFiles` are the STL basenames the MJCF's `<asset>` block references; they
 * are placed under `<workDir>/assets/` to match the MJCF `meshdir="assets"`.
 */
export async function loadG1Sim(opts: {
  baseUrl: string; // e.g. `${import.meta.env.BASE_URL}robots/g1/mjcf/`
  sceneXml: string; // basename of the scene MJCF, e.g. `scene_g1.xml`
  meshFiles: string[]; // STL basenames under `assets/`
  onProgress?: (loaded: number, total: number) => void;
  /**
   * Optional transform applied to the scene XML text before it is compiled.
   * The live engine uses this to inject an `<option>` that pins the physics
   * timestep/integrator/solver to match training, without mutating the shared
   * scene file (which the spike + source MJCF mirror unchanged).
   */
  xmlTransform?: (xml: string) => string;
}): Promise<MujocoSim> {
  const mujoco = await getMujoco();
  const FS = mujoco.FS;
  const workDir = '/work';
  const assetsDir = `${workDir}/assets`;

  // (Re)create a clean working directory in MEMFS.
  try {
    FS.mkdir(workDir);
  } catch {
    /* already exists */
  }
  try {
    FS.mkdir(assetsDir);
  } catch {
    /* already exists */
  }

  // Fetch the scene XML as text, optionally transforming it (e.g. to pin the
  // <option> physics timing for training parity).
  let xmlText = await fetchText(`${opts.baseUrl}${opts.sceneXml}`);
  if (opts.xmlTransform) xmlText = opts.xmlTransform(xmlText);
  FS.writeFile(`${workDir}/${opts.sceneXml}`, xmlText);

  // Fetch + write every mesh in parallel, reporting progress.
  let done = 0;
  const total = opts.meshFiles.length;
  await Promise.all(
    opts.meshFiles.map(async (name) => {
      const bytes = await fetchBytes(`${opts.baseUrl}assets/${name}`);
      FS.writeFile(`${assetsDir}/${name}`, bytes);
      done += 1;
      opts.onProgress?.(done, total);
    }),
  );

  // Compile the model from the MJCF on the virtual FS.
  const model = mujoco.MjModel.from_xml_path(`${workDir}/${opts.sceneXml}`);
  const data = new mujoco.MjData(model);

  // Forward once so xpos/xquat are valid before the first step/render.
  mujoco.mj_forward(model, data);

  const nbody = model.nbody as number;
  const bodyNameToId = new Map<string, number>();
  for (let i = 0; i < nbody; i++) {
    // `data.body(i).name` resolves the body name via named access.
    const accessor = data.body(i);
    bodyNameToId.set(accessor.name, i);
    accessor.delete();
  }

  return {
    mujoco,
    model,
    data,
    nbody,
    nq: model.nq as number,
    nv: model.nv as number,
    nu: model.nu as number,
    timestep: model.opt.timestep as number,
    bodyNameToId,
  };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
