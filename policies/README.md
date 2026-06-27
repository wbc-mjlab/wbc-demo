# `policies/` — one folder per policy

This directory is the data source for the demo gallery. **Adding a policy = drop
a folder here and open a PR.** No code changes are needed: the site discovers
every `policies/<id>/policy.yaml` at build time (see
[`src/registry.ts`](../src/registry.ts)) and renders a gallery card + a
per-policy page for each one.

## Folder layout

```
policies/
  policy.schema.json           # JSON Schema for policy.yaml (do not move/rename)
  <policy-id>/                 # URL-safe id; also the gallery/page slug
    policy.yaml                # the MANIFEST (required) — see below
    policy.onnx                # trained policy network (M2 live engine)
    config.yaml                # deploy obs/action config (schema_version: wbc_tracking_params_v1)
    thumb.png                  # gallery thumbnail (optional)
    motion_library.yaml        # clip-library manifest (optional; clips form B)
    clips/                     # recorded playback clips (optional; clips form A)
      walk-forward.json
      ...
```

- `<policy-id>` is the folder name. It is the **authoritative** id and the URL
  slug (`policy.html?id=<policy-id>`). Use lowercase kebab-case. A manifest may
  also carry an `id:`, but it is advisory and should match the folder name.
- Only `policy.yaml` is required for the policy to appear in the gallery. The
  other artifacts power features that are still landing (playback, live engine).
- These artifacts are produced per-policy by the **exporter** (issue
  wbc-mjlab-5uw); this schema is the contract that exporter must honor.

## The manifest: `policy.yaml`

`policy.yaml` is **human-authored metadata + pointers**. It references the
machine artifacts in the folder — it does **not** duplicate their contents.

The schema is **final** (issue wbc-mjlab-0d8). It is defined by two synced files:

- [`policies/policy.schema.json`](policy.schema.json) — the authoritative JSON
  Schema (draft 2020-12). This is what validation runs against.
- [`src/types.ts`](../src/types.ts) — the TypeScript view of the same contract
  (`PolicyManifest`), used by the frontend.

Validate locally before opening a PR:

```bash
npm run validate     # validates every policies/*/policy.yaml; exits non-zero on failure
```

The build (`npm run build`) also skips + warns on any invalid manifest so one
bad PR can't take the gallery down, and CI (issue wbc-mjlab-2of) runs
`npm run validate` as a hard gate.

### Fields

| Field | Req | Type | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | string | Manifest schema version. Currently `"1"`. |
| `name` | ✅ | string | Display name on the card + page. |
| `id` | — | string | Optional; folder name is authoritative. |
| `description` | — | string | One-line gallery card summary. |
| `robot` | — | string | Embodiment id, e.g. `"g1"`. Matches `config.yaml`'s `robot_id`. Selects the robot GLB (wbc-mjlab-9as). |
| `tags` | — | string[] | Skill/grouping tags. Known set suggested (see below); any string allowed. |
| `author` | — | string | Contributor name/handle. |
| `links` | — | object | `{ paper?, code?, runUrl? }`, all URIs. |
| `thumbnail` | — | string | Card image path, relative to the folder. |
| `defaultClip` | — | string | Clip id to show first. |
| `camera` | — | preset \| pose | `"default"\|"front"\|"side"\|"top"\|"orbit"`, or `{ pos:[x,y,z], target:[x,y,z] }` (metres, Three.js axes, Y up). |
| `artifacts` | — | object | Pointers to machine artifacts (below). Required for the M2 live engine. |

**Known tags** (suggested for consistent filtering; arbitrary tags are still
accepted): `walk`, `run`, `sprint`, `jump`, `flip`, `fight`, `dance`, `getup`,
`crawl`, `locomotion`, `manipulation`, `sport`.

### `artifacts`

| Field | Req | Type | Notes |
| --- | --- | --- | --- |
| `onnx` | ✅* | string | ONNX policy network, e.g. `"policy.onnx"`. (*required only if an `artifacts` block is present.) |
| `config` | — | string | Deploy obs/action config (`schema_version: wbc_tracking_params_v1`); consumed by the M2 engine. |
| `clips` | — | object | Playback clips (wbc-mjlab-3ne). Pick **one** of the two forms below. |

### Clips — pick ONE form

**(A) inline** — a small, hand-curated showcase set with display metadata:

```yaml
artifacts:
  clips:
    kind: inline
    clips:
      - id: "walk-forward"
        name: "Walk forward"
        file: "clips/walk-forward.json"   # relative to the policy folder
        tags: ["walk"]                     # optional
        durationSec: 4.0                   # optional
```

**(B) manifest** — point at a `motion_library.yaml` (`schema:
wbc_motion_library_v1`) in the folder and let per-clip names/files resolve from
it at load time. Best for the exporter's bulk output (don't copy the clip list
into `policy.yaml`):

```yaml
artifacts:
  clips:
    kind: manifest
    file: "motion_library.yaml"
    default: "walk1_subject1"   # optional; clip id from the library
```

### Paths

All paths in the manifest (`thumbnail`, `artifacts.onnx`, `artifacts.config`,
`artifacts.clips[*].file`, `artifacts.clips.file`) are **relative to the policy
folder** and resolved at runtime against the folder's published URL. Absolute
paths and `..` escapes are rejected by the schema.

### Minimal example

```yaml
schemaVersion: "1"
name: "Walk Forward"
robot: "g1"
tags: ["walk", "locomotion"]
artifacts:
  onnx: "policy.onnx"
  config: "config.yaml"
```

A complete, fully-commented example is in
[`_example/policy.yaml`](_example/policy.yaml).

## Notes

- `_example/` is a **removable placeholder** so the gallery renders something
  before real policies exist. It also serves as the canonical commented example.
  Delete it once the first real policy is added.
- Related issues: **wbc-mjlab-0d8** (this schema), **wbc-mjlab-5uw** (exporter
  that emits these artifacts), **wbc-mjlab-2of** (CI runs `npm run validate`),
  **wbc-mjlab-3ne** (playback rendering), **wbc-mjlab-9as** (robot meshes), M2
  (live engine: mujoco-wasm + onnxruntime-web).
