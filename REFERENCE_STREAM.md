# Reference Stream Format (`wbc_reference_stream_v1`)

The per-clip **reference command** the in-browser live policy needs (issues
wbc-mjlab-bpu obs-port, wbc-mjlab-uxq loop). Produced by wbc-mjlab's
`wbc-mjlab-export-web-reference`. The browser runs `policy.onnx` live and builds
the full actor observation by concatenating this reference stream with live
proprioception from its own sim — this format ships ONLY the reference terms.

## Layout (per policy folder)
- `reference/<clipId>.bin` — raw little-endian Float32, **no header**, frame-major
  `frames × commandDim`. `commandDim = 39` for G1.
- `reference/index.json` — listing + term layout (below).

## Per-frame command (39 dims, in this exact order)
| Offset | Term | Dims | Meaning |
|--------|------|------|---------|
| 0  | `ref_base_height`    | 1  | anchor (`torso_link`) world Z, metres (env origin Z = 0) |
| 1  | `ref_base_lin_vel_b` | 3  | anchor linear velocity in the anchor frame, m/s |
| 4  | `ref_base_ang_vel_b` | 3  | anchor angular velocity in the anchor frame, rad/s |
| 7  | `ref_gravity_b`      | 3  | gravity unit vector `(0,0,-1)` rotated into the anchor frame |
| 10 | `ref_joint_pos`      | 29 | reference joint positions, `config.yaml` `joint_names` order, rad |

Frames in the MuJoCo **Z-up world**; quaternions are `w,x,y,z`. The body-frame
terms are `quat_apply_inverse(anchor_quat_w, v_w)` = rotate the world vector by
the conjugate of the anchor orientation. This must equal the deploy
`config.yaml` `tracking.reference_observation_names`; do not reorder.

## Reading a clip (JS)
```js
const buf = await (await fetch(`reference/${clip.file}`)).arrayBuffer();
const f32 = new Float32Array(buf);              // length === frames * commandDim
const frame = (i) => f32.subarray(i * commandDim, (i + 1) * commandDim);
// frame(i) is the 39-vector for frame i. Validate: buf.byteLength === frames*commandDim*4
```

## index.json (`wbc_reference_stream_v1`)
```json
{
  "schema": "wbc_reference_stream_v1",
  "robot": "g1",
  "commandDim": 39,
  "fps": 50.0,
  "refTerms": [
    {"name": "ref_base_height", "dim": 1},
    {"name": "ref_base_lin_vel_b", "dim": 3},
    {"name": "ref_base_ang_vel_b", "dim": 3},
    {"name": "ref_gravity_b", "dim": 3},
    {"name": "ref_joint_pos", "dim": 29}
  ],
  "clips": [
    {"id": "walk1_subject1", "name": "Walk1 Subject1",
     "file": "walk1_subject1.bin", "frames": 13065,
     "durationSec": 261.3, "tags": ["walk", "locomotion"]}
  ]
}
```
Step the stream at `fps`. `policy.yaml` `artifacts.clips` (kind `manifest`)
points at `motion_library.yaml`; clip ids there key these reference files.
Fidelity: matches mjlab's `MotionCommand` and the deploy C++ `WbcMotionLoader`
(max abs err ~3.6e-7, float32).

> The full actor observation the policy consumes is this reference stream **+**
> live proprioception (`base_ang_vel`, `projected_gravity`, `joint_pos`,
> `joint_vel`, last `actions`) from the in-browser sim, concatenated in
> `config.yaml` `tracking.actor_observation_names` order. See the obs-port issue
> wbc-mjlab-bpu (ported from `wbc-g1-deploy`).
