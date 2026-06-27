# `policies/` — one folder per policy

This directory is the data source for the demo gallery. **Adding a policy = drop
a folder here and open a PR.** No code changes are needed: the site discovers
every `policies/<id>/policy.yaml` at build time (see
[`src/registry.ts`](../src/registry.ts)) and renders a gallery card + a
per-policy page for each one.

## Folder layout

```
policies/
  <policy-id>/                 # URL-safe id; also the gallery/page slug
    policy.yaml                # the MANIFEST (required) — see below
    policy.onnx                # trained policy network (used by the M2 live engine)
    config.yaml                # training/runtime config (provenance)
    thumb.png                  # gallery thumbnail (optional)
    clips/                     # recorded playback clips (optional)
      walk-forward.json
      ...
```

- `<policy-id>` is the folder name. It is the authoritative id and the URL slug
  (`policy.html?id=<policy-id>`). Use lowercase kebab-case.
- Only `policy.yaml` is required for the policy to appear in the gallery. The
  other artifacts power features that are still landing (playback, live engine).

## The manifest: `policy.yaml`

> ⚠️ **The schema is INTERIM.** The fields below are the minimal set the current
> frontend reads (see [`src/types.ts`](../src/types.ts)). The authoritative
> schema is defined by issue **wbc-mjlab-0d8** — follow that issue for the final
> field list, required/optional rules, and validation. Until it lands, only
> `name` is strictly required.

```yaml
# policies/<policy-id>/policy.yaml  (INTERIM schema — see wbc-mjlab-0d8)
name: "Walk Forward"                 # required — display name
description: "Flat-ground forward locomotion."   # optional — gallery card text
tags: ["locomotion", "unitree_g1"]   # optional — grouping/filtering
robot: "unitree_g1"                  # optional — embodiment; selects the GLB (wbc-mjlab-9as)
onnx: "policy.onnx"                   # optional — ONNX file in this folder (M2 live engine)
thumbnail: "thumb.png"               # optional — image in this folder
clips:                               # optional — playback clips (wbc-mjlab-3ne)
  - label: "Walk forward"
    src: "clips/walk-forward.json"
```

Paths in the manifest (`thumbnail`, `onnx`, `clips[].src`) are **relative to the
policy folder** and resolved at runtime against the folder's published URL.

## Notes

- `_example/` is a **removable placeholder** so the gallery renders something
  before real policies exist. Delete it once the first real policy is added.
- Related issues: **wbc-mjlab-0d8** (manifest schema), **wbc-mjlab-3ne**
  (playback rendering), **wbc-mjlab-9as** (robot meshes), M2 (live engine:
  mujoco-wasm + onnxruntime-web).
