# G1 robot web assets

- `g1.meshopt.glb` — Unitree G1 visual meshes, **meshopt-compressed** (2.1 MB). Requires
  `MeshoptDecoder` wired into the Three.js `GLTFLoader`. One glTF node per MuJoCo body, named
  by body, flat under the scene root, at rest (identity). The renderer sets each node's WORLD
  transform per frame from clip pose data.
- `g1.bodies.json` — ordered body list (31; index 0 = `world`, no mesh). The pose-order
  contract for clip `.bin` data — see [`../../../CLIP_FORMAT.md`](../../../CLIP_FORMAT.md).

Frame convention: **MuJoCo Z-up world**, quaternion `(w,x,y,z)`. The renderer converts to
three.js Y-up.

**Live sim MJCF:** `mjcf/scene_g1.xml` is kept in sync with
`unitree_rl_mjlab/src/assets/robots/unitree_g1/xmls/scene_g1.xml` (deploy
`unitree_mujoco` simulate). Physics uses MuJoCo defaults (no injected `<option>`).

**Visual GLB:** regenerated from `wbc-mjlab/.../g1.xml` (issue wbc-mjlab-9as);
regenerate the GLB and `g1.bodies.json` together if the MJCF body list changes.
