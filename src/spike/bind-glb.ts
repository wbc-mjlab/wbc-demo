/**
 * Render path A (PREFERRED): drive the existing visual GLB's per-body nodes
 * from the MuJoCo sim's body world transforms.
 *
 * SPIKE ONLY — issue wbc-mjlab-x2t. The GLB (`g1.meshopt.glb`) has one node per
 * MuJoCo body, named by body, flat under the scene root, at rest. Each frame we
 * read `data.xpos[3*b .. ]` and `data.xquat[4*b .. ]` (MuJoCo Z-up world,
 * quat = w,x,y,z) and write them onto the matching GLB node, converting MuJoCo
 * Z-up → Three.js Y-up with a single fixed parent rotation.
 *
 * This reuses the project's existing visual asset + the per-body contract in
 * `g1.bodies.json`, so the physics never has to ship pretty visual meshes.
 */

import {
  Group,
  Object3D,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { MujocoSim } from './mujoco';

/**
 * Fixed rotation taking MuJoCo's Z-up world into Three.js' Y-up world:
 * rotate -90° about the X axis (Z → Y, Y → -Z).
 */
const Z_UP_TO_Y_UP = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);

export interface GlbBinding {
  /** The wrapper group (already Z-up→Y-up rotated) added under robotRoot. */
  readonly root: Group;
  /** Push the current sim body transforms onto the GLB nodes. */
  sync(sim: MujocoSim): void;
  /** Bodies present in the sim that had no matching GLB node (diagnostics). */
  readonly unmatchedBodies: string[];
}

/**
 * Load the GLB and wire each named body node to a sim body id. The returned
 * group is rotated once (Z-up→Y-up) and parented under `parent`; per-frame we
 * then set each child node's LOCAL transform straight from MuJoCo world pose,
 * because the wrapper rotation handles the frame conversion for the whole tree.
 */
export async function bindGlbToSim(opts: {
  glbUrl: string;
  sim: MujocoSim;
  parent: Object3D;
}): Promise<GlbBinding> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(opts.glbUrl);

  // Wrapper carries the single world-frame conversion. Body nodes hang under it
  // and receive raw MuJoCo world pose as their local transform.
  const root = new Group();
  root.name = 'g1-glb-bound';
  root.quaternion.copy(Z_UP_TO_Y_UP);

  // Collect the body nodes by name. The GLB has them flat under scene root.
  const nodeByName = new Map<string, Object3D>();
  gltf.scene.traverse((obj) => {
    if (obj.name) nodeByName.set(obj.name, obj);
  });

  // Build the id→node binding list, re-parenting matched nodes under `root`.
  const bound: Array<{ bodyId: number; node: Object3D }> = [];
  const unmatchedBodies: string[] = [];
  for (const [name, bodyId] of opts.sim.bodyNameToId) {
    if (name === 'world') continue; // index 0 has no mesh
    const node = nodeByName.get(name);
    if (node) {
      // Detach from its GLTF parent and reparent under our rotated wrapper so
      // we can set its transform directly in MuJoCo world coordinates.
      node.matrixAutoUpdate = true;
      root.add(node);
      bound.push({ bodyId, node });
    } else {
      unmatchedBodies.push(name);
    }
  }

  opts.parent.add(root);

  const tmpPos = new Vector3();
  const tmpQuat = new Quaternion();

  function sync(sim: MujocoSim): void {
    // Live typed-array views, declared `any` in the bindings; read via `any`
    // locals so element access is `any` (indices are provably in range).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xpos: any = sim.data.xpos; // [nbody*3], world position
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const xquat: any = sim.data.xquat; // [nbody*4], world quat (w,x,y,z)
    for (const { bodyId, node } of bound) {
      const p = bodyId * 3;
      const q = bodyId * 4;
      // MuJoCo position is already in the (Z-up) world; the wrapper rotation
      // re-expresses it as Y-up when the scene graph composes transforms.
      tmpPos.set(xpos[p], xpos[p + 1], xpos[p + 2]);
      // three.js quaternion order is (x,y,z,w); MuJoCo is (w,x,y,z).
      tmpQuat.set(xquat[q + 1], xquat[q + 2], xquat[q + 3], xquat[q]);
      node.position.copy(tmpPos);
      node.quaternion.copy(tmpQuat);
    }
  }

  return { root, sync, unmatchedBodies };
}

/**
 * Reframe the camera/controls on a scene's bounding content. Small helper so the
 * spike page can frame the robot once the GLB is bound and stepped.
 */
export function exposeScene(_scene: Scene): void {
  /* no-op hook kept for symmetry; framing handled by the page. */
}
