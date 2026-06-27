/**
 * Render path B (COMPARISON): MuJoCo's own geom renderer.
 *
 * SPIKE ONLY — issue wbc-mjlab-x2t. Instead of reusing the project's GLB, this
 * builds Three.js meshes straight from the COMPILED model's geoms — primitive
 * types (sphere/capsule/cylinder/box/plane) plus actual mesh buffers
 * (`model.mesh_vert` / `model.mesh_face`) for `mjGEOM_MESH`. Each frame it reads
 * `data.geom_xpos` / `data.geom_xmat` (per-geom world transform) and updates the
 * matrices. This is the same approach zalo/mujoco_wasm's Three.js demo uses.
 *
 * We render this side-by-side with the GLB path so the report can recommend one.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import type { MujocoSim } from './mujoco';

// MuJoCo geom type ids (mjtGeom).
const PLANE = 0;
const SPHERE = 2;
const CAPSULE = 3;
const ELLIPSOID = 4;
const CYLINDER = 5;
const BOX = 6;
const MESH = 7;

const Z_UP_TO_Y_UP = new Quaternion().setFromAxisAngle(
  new Vector3(1, 0, 0),
  -Math.PI / 2,
);

export interface GeomBinding {
  readonly root: Group;
  sync(sim: MujocoSim): void;
  readonly geomCount: number;
}

/**
 * Build a Three.js mesh per visible geom. We render only the VISUAL geoms
 * (group 1/2 — the pretty meshes) so it's a fair visual comparison with the GLB
 * path; collision primitives are skipped. The wrapper group carries the single
 * Z-up→Y-up conversion just like the GLB path.
 */
export function buildGeomRenderer(opts: {
  sim: MujocoSim;
  parent: Object3D;
  /** Geom groups to include (MuJoCo `geom_group`). Visual meshes are 1 or 2. */
  includeGroups?: Set<number>;
}): GeomBinding {
  const { sim } = opts;
  const m = sim.model;
  const ngeom = m.ngeom as number;
  // Live typed-array views, declared `any` in the bindings; read via `any`
  // locals so element access is `any` (indices are provably in range).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const geomType: any = m.geom_type;
  const geomSize: any = m.geom_size; // [ngeom*3]
  const geomRgba: any = m.geom_rgba; // [ngeom*4]
  const geomGroup: any = m.geom_group;
  const geomDataId: any = m.geom_dataid; // mesh id, or -1
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const include = opts.includeGroups ?? new Set([1, 2]);

  const root = new Group();
  root.name = 'g1-geom-bound';
  root.quaternion.copy(Z_UP_TO_Y_UP);

  // Per-geom Three.js mesh, indexed by geom id (null for skipped geoms).
  const meshes: Array<Mesh | null> = new Array(ngeom).fill(null);
  let geomCount = 0;

  for (let g = 0; g < ngeom; g++) {
    if (!include.has(geomGroup[g])) continue;
    const geometry = makeGeometry(
      geomType[g],
      geomSize.subarray(g * 3, g * 3 + 3),
      geomDataId[g],
      sim,
    );
    if (!geometry) continue;
    const r = g * 4;
    const material = new MeshStandardMaterial({
      color: new Color(geomRgba[r], geomRgba[r + 1], geomRgba[r + 2]),
      roughness: 0.7,
      metalness: 0.1,
    });
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false; // we set the matrix directly each frame
    meshes[g] = mesh;
    root.add(mesh);
    geomCount += 1;
  }

  opts.parent.add(root);

  const tmpMat = new Matrix4();

  function sync(s: MujocoSim): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gxpos: any = s.data.geom_xpos; // [ngeom*3]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gxmat: any = s.data.geom_xmat; // [ngeom*9] row-major
    for (let g = 0; g < ngeom; g++) {
      const mesh = meshes[g];
      if (!mesh) continue;
      const p = g * 3;
      const r = g * 9;
      // Compose a world matrix from MuJoCo rotation (row-major 3x3) + position.
      // three.js Matrix4.set takes row-major args, so this maps cleanly.
      tmpMat.set(
        gxmat[r + 0], gxmat[r + 1], gxmat[r + 2], gxpos[p + 0],
        gxmat[r + 3], gxmat[r + 4], gxmat[r + 5], gxpos[p + 1],
        gxmat[r + 6], gxmat[r + 7], gxmat[r + 8], gxpos[p + 2],
        0, 0, 0, 1,
      );
      mesh.matrix.copy(tmpMat);
    }
  }

  return { root, sync, geomCount };
}

/**
 * Build the Three.js geometry for one MuJoCo geom. MuJoCo geom sizes are
 * half-extents; primitives are axis-aligned in MuJoCo's convention (cylinders/
 * capsules along local Z), so we rotate the cap geometries +90° about X to match
 * three.js' Y-axis convention.
 */
function makeGeometry(
  type: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  size: any, // length-3 view of geom half-extents
  dataId: number,
  sim: MujocoSim,
): BufferGeometry | null {
  switch (type) {
    case PLANE:
      // size[0],size[1] are half-extents; 0 means "infinite" → use a large quad.
      return new PlaneGeometry(
        (size[0] || 10) * 2,
        (size[1] || 10) * 2,
      ).rotateX(-Math.PI / 2);
    case SPHERE:
      return new SphereGeometry(size[0], 24, 16);
    case CAPSULE: {
      // MuJoCo capsule: radius=size[0], half-length(of cylinder part)=size[1],
      // axis along local Z. three.js capsule axis is Y.
      const geo = new CapsuleGeometry(size[0], size[1] * 2, 8, 16);
      geo.rotateX(Math.PI / 2);
      return geo;
    }
    case CYLINDER: {
      const geo = new CylinderGeometry(size[0], size[0], size[1] * 2, 24);
      geo.rotateX(Math.PI / 2);
      return geo;
    }
    case ELLIPSOID: {
      const geo = new SphereGeometry(1, 24, 16);
      geo.scale(size[0], size[1], size[2]);
      return geo;
    }
    case BOX:
      return new BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2);
    case MESH:
      return dataId >= 0 ? makeMeshGeometry(dataId, sim) : null;
    default:
      return null;
  }
}

/**
 * Build a BufferGeometry from MuJoCo's compiled mesh buffers for mesh `dataId`.
 * `mesh_vert` is a flat [nvert*3] float array; `mesh_face` is [nface*3] ints.
 */
function makeMeshGeometry(dataId: number, sim: MujocoSim): BufferGeometry {
  const m = sim.model;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const vertAdr: number = (m.mesh_vertadr as any)[dataId];
  const vertNum: number = (m.mesh_vertnum as any)[dataId];
  const faceAdr: number = (m.mesh_faceadr as any)[dataId];
  const faceNum: number = (m.mesh_facenum as any)[dataId];
  const allVerts: any = m.mesh_vert;
  const allFaces: any = m.mesh_face;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const positions = new Float32Array(vertNum * 3);
  positions.set(allVerts.subarray(vertAdr * 3, (vertAdr + vertNum) * 3));

  const indices = new Uint32Array(faceNum * 3);
  // Face indices are global vertex ids; subtract this mesh's vert base.
  for (let i = 0; i < faceNum * 3; i++) {
    indices[i] = allFaces[faceAdr * 3 + i] - vertAdr;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(positions, 3));
  geo.setIndex(new BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}
