# `policies/` — one folder per policy

This directory is the data source for the demo gallery. **Adding a policy = drop
a folder here and open a PR.** No code changes are needed: the site discovers
every `policies/<id>/policy.yaml` at build time (see
[`src/registry.ts`](../src/registry.ts)) and renders gallery cards + a per-policy
page for each one.

> New here? [`../CONTRIBUTING.md`](../CONTRIBUTING.md) walks the full onboarding
> path (export from wbc-mjlab → drop folder → validate → PR). This file is the
> folder-layout + manifest field reference.

## Folder layout

```
policies/
  policy.schema.json           # JSON Schema for policy.yaml (do not move/rename)
  <policy-id>/                 # URL-safe id; also the gallery/page slug
    policy.yaml                # the MANIFEST (required) — see below
    policy.onnx                # trained policy network (onnxruntime-web runs it live)
    config.yaml                # deploy obs/action config (schema_version: wbc_tracking_params_v1)
    gen/params/                # optional Gen locomotion (config.yaml + generator.onnx)
    reference/
      index.json               # all exported clip streams (schema: wbc_reference_stream_v1)
      manifest.yaml            # browsable clip list + pose_clips (mirrors deploy manifest.yaml)
      <clip>.bin               # per-clip reference-command stream (frames × 39, float32)
    motion_library.yaml        # clip-library provenance (optional)
    thumb.png                  # gallery thumbnail (optional)
```

Optional **Gen** mode: ship `gen/params/` (`wbc_gen_deploy_params_v2` + `generator.onnx`)
and set `artifacts.gen: gen/params/` — the live page then toggles with **G** / **gen**.

- `<policy-id>` is the folder name. It is the **authoritative** id and the URL
  slug (`policy.html?id=<policy-id>`). Use lowercase kebab-case. A manifest may
  also carry an `id:`, but it is advisory and should match the folder name.
- Only `policy.yaml` is required for the policy to appear in the gallery. To run
  **live**, a folder also needs `policy.onnx`, `config.yaml`, a
  `reference/index.json`, and `robot: g1`.
- These artifacts are produced per-policy by the **exporter**
  (`wbc-mjlab-export-web-reference`); this schema is the contract it honors.

## The manifest: `policy.yaml`

`policy.yaml` is **human-authored metadata + pointers**. It references the machine
artifacts in the folder — it does **not** duplicate their contents.

The schema is defined by two synced files:

- [`policies/policy.schema.json`](policy.schema.json) — the authoritative JSON
  Schema (draft 2020-12), what validation runs against.
- [`src/types.ts`](../src/types.ts) — the TypeScript view (`PolicyManifest`).

Validate before opening a PR:

```bash
npm run validate     # validates every policies/*/policy.yaml; exits non-zero on failure
```

The build (`npm run build`) also skips + warns on an invalid manifest so one bad
PR can't take the gallery down, and CI runs `npm run validate` as a hard gate.

### Fields

| Field | Req | Type | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | ✅ | string | Manifest schema version. Currently `"1"`. |
| `name` | ✅ | string | Display name on the card + page. |
| `id` | — | string | Optional; folder name is authoritative. |
| `description` | — | string | One-line gallery card summary. |
| `robot` | — | string | Embodiment id, e.g. `"g1"`. Selects the shared robot assets; live rendering supports `g1`. |
| `tags` | — | string[] | Skill/grouping tags. Known set suggested (below); any string allowed. |
| `author` | — | string | Contributor name/handle. |
| `links` | — | object | `{ paper?, code?, runUrl? }`, all URIs. |
| `thumbnail` | — | string | Card image path, relative to the folder. |
| `defaultClip` | — | string | Clip id to show first. |
| `camera` | — | preset \| pose | `"default"\|"front"\|"side"\|"top"\|"orbit"`, or `{ pos:[x,y,z], target:[x,y,z] }` (metres, Three.js Y-up). |
| `artifacts` | — | object | Pointers to machine artifacts (below). Needed to run live. |

**Known tags** (suggested; arbitrary tags still accepted): `walk`, `run`,
`sprint`, `jump`, `flip`, `fight`, `dance`, `getup`, `crawl`, `locomotion`,
`manipulation`, `sport`.

### `artifacts`

| Field | Req | Type | Notes |
| --- | --- | --- | --- |
| `onnx` | ✅* | string | ONNX policy network, e.g. `"policy.onnx"`. (*required if an `artifacts` block is present.) |
| `config` | — | string | Deploy obs/action config (`schema_version: wbc_tracking_params_v1`); consumed by the live engine. |
| `clips` | — | object | Optional clip metadata (inline list or `motion_library.yaml` pointer). Informational — **browsable clips** come from `reference/manifest.yaml` (fallback: all non-pose entries in `index.json`). |

### Paths

All manifest paths (`thumbnail`, `artifacts.onnx`, `artifacts.config`, clip
`file`s) are **relative to the policy folder** and resolved at runtime against the
folder's published URL. Absolute paths and `..` escapes are rejected by the schema.

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
  before real policies exist. It is also the canonical commented example. Delete
  it once the first real policy is added.
