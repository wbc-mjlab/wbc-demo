# Contributing — add a policy to the demo

This repo is **data-driven**: the gallery is built from whatever policy folders
are committed under [`policies/`](policies/). Publishing a trained policy is a
**content PR, not a code change** — drop a folder, fill one manifest, open a PR.
The build discovers it and renders live cards + a per-policy page automatically.

This guide is the end-to-end path from a trained checkpoint in
[`wbc-mjlab`](https://github.com/wbc-mjlab) to a live demo.

> Field-by-field manifest reference: [`policies/README.md`](policies/README.md).
> The authoritative contract is [`policies/policy.schema.json`](policies/policy.schema.json),
> mirrored by `PolicyManifest` in [`src/types.ts`](src/types.ts).

---

## TL;DR

```bash
# 1. in wbc-mjlab — export a ready-to-drop folder from a trained run
wbc-mjlab-export-web-reference --task Wbc-G1 --dataset <name> \
  --run <run> --out /path/to/wbc-demo/policies/<policy-id>

# 2. in wbc-demo — validate + preview
npm install
npm run validate            # must PASS
npm run dev                 # eyeball the gallery + policy page

# 3. open a PR. CI re-runs validate + build; merge to main deploys.
```

`<policy-id>` is lowercase **kebab-case** and becomes the URL slug
(`policy.html?id=<policy-id>`).

---

## 1. Export from wbc-mjlab

In `wbc-mjlab`, run `wbc-mjlab-export-web-reference` against a trained run. It
emits a **ready-to-drop** `policies/<policy-id>/` folder with everything the live
engine needs:

```
policies/<policy-id>/
  policy.onnx           # the trained network (onnxruntime-web runs it live)
  config.yaml           # deploy obs/action layout (schema_version: wbc_tracking_params_v1)
  reference/
    index.json          # clip list + term layout (schema: wbc_reference_stream_v1)
    <clip>.bin          # per-clip reference-command stream (frames × 39, float32)
  motion_library.yaml   # clip-library provenance (optional)
  thumb.png             # gallery thumbnail
  policy.yaml           # the MANIFEST — pre-filled, ready to edit
```

The exporter pre-fills `policy.yaml` pointing at the artifacts it produced. You
normally only edit the **human metadata** (name, description, tags, links) before
committing — see step 3. Check `--help` for the current flags; the folder *layout*
above is the contract this repo guarantees.

**What runs in the browser:** the engine loads `config.yaml` (obs/action layout)
+ `policy.onnx` + `reference/index.json`, then for each clip steps a MuJoCo sim
driven by the policy. The clip list shown in the gallery and the per-policy picker
comes from `reference/index.json`. The reference-stream wire format is documented
in [`REFERENCE_STREAM.md`](REFERENCE_STREAM.md).

> Robot assets (MJCF + meshes) are **shared**, not shipped per policy — they live
> in [`public/robots/<robot>/`](public/robots/) and are selected by your manifest's
> `robot` field. Live rendering currently supports `robot: g1`.

---

## 2. Drop the folder

Place it under `policies/<policy-id>/`:

- `<policy-id>` is the **folder name** — the authoritative id and URL slug. Use
  lowercase kebab-case (`^[a-z0-9][a-z0-9-]*$`), e.g. `g1-sprint`, `tracking-v2`.
- Artifacts are **committed directly** to this repo (no external storage / LFS today).

---

## 3. Fill `policy.yaml`

`policy.yaml` is **human-authored metadata + pointers** — it references the machine
artifacts, never duplicates them. Only `schemaVersion` and `name` are required.

```yaml
schemaVersion: "1"            # required — manifest schema version (currently "1")
name: "G1 Sprint"             # required — display name on the card + page
description: "High-speed forward locomotion on flat ground."
robot: "g1"                   # embodiment id; selects the shared robot assets
tags: ["sprint", "run", "locomotion"]
author: "your-handle"
links:
  paper: "https://example.com/paper"
  code: "https://github.com/wbc-mjlab/wbc-mjlab"
  runUrl: "https://wandb.ai/<entity>/<project>/runs/<id>"
thumbnail: "thumb.png"        # relative to this folder
camera: "default"             # preset, or an explicit { pos, target } pose
artifacts:
  onnx: "policy.onnx"         # required inside `artifacts` — the live engine needs it
  config: "config.yaml"       # obs/action layout the engine consumes
```

Field-by-field:

| Field | Req | What it does |
| --- | --- | --- |
| `schemaVersion` | yes | Manifest schema version. Currently the string `"1"`. |
| `name` | yes | Display name on the card and policy page. |
| `id` | — | Advisory only; the **folder name** is authoritative. Omit or match it. |
| `description` | — | One-line summary for the gallery card. |
| `robot` | — | Embodiment id, e.g. `"g1"`. Selects the shared robot assets; live rendering supports `g1`. |
| `tags` | — | Skill/grouping tags for filtering. Known set below; arbitrary tags allowed. |
| `author` | — | Your name or handle. |
| `links` | — | `{ paper?, code?, runUrl? }` — optional URLs surfaced on the policy page. |
| `thumbnail` | — | Card image path, relative to the folder. |
| `defaultClip` | — | Clip id to show first; falls back to the first clip otherwise. |
| `camera` | — | A preset (`default`/`front`/`side`/`top`/`orbit`) **or** an explicit `{ pos:[x,y,z], target:[x,y,z] }` pose (metres, three.js Y-up). |
| `artifacts` | — | Pointers to the machine artifacts. **`onnx` is required** for the live engine. |

**Known tags** (preferred for consistent filtering; any string is still accepted):
`walk`, `run`, `sprint`, `jump`, `flip`, `fight`, `dance`, `getup`, `crawl`,
`locomotion`, `manipulation`, `sport`.

> All manifest paths (`thumbnail`, `artifacts.onnx`, `artifacts.config`) are
> **relative to the policy folder**. Absolute paths and `..` escapes are rejected.

The fully-commented reference manifest is
[`policies/_example/policy.yaml`](policies/_example/policy.yaml).

---

## 4. Validate + preview locally

```bash
npm install        # first time only (Node ≥ 20.19 or ≥ 22.12, per Vite 8)
npm run validate   # validates EVERY policies/*/policy.yaml against the schema
npm run dev        # Vite dev server at http://localhost:5173/wbc-demo/
```

`npm run validate` prints a per-file `PASS`/`FAIL` and exits non-zero on any
failure — **it must pass before you open a PR** (CI runs the same gate). It checks
the manifest *text* against the schema; it does **not** verify that the files you
point at exist, so double-check artifact paths yourself. Then open the gallery,
confirm your cards run live, and click into the policy page.

---

## 5. Open a PR

Commit the new `policies/<policy-id>/` folder and open a pull request.

- **CI** runs `npm run validate` + `npm run build` on the PR. The build also
  skips-and-warns on an invalid manifest, so one bad manifest can't take the whole
  gallery down — but a `validate` failure is a hard gate.
- **On merge to `main`**, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds the site and publishes `dist/` to GitHub Pages.

If you added the **first** real policy, delete the `policies/_example/` placeholder
in the same PR (the registry sorts it last and only keeps it so the gallery isn't empty).

---

## Troubleshooting

**`npm run validate` fails.** The output names the file and rule. Common causes:
`schemaVersion` not the quoted string `"1"`; an unknown field (the schema is strict
— `additionalProperties: false`); an id that isn't lowercase kebab-case; or an
absolute/`..` path.

**My card shows but never goes live.** The live engine needs `artifacts.onnx` +
`config.yaml` + a `reference/index.json` in the folder, and `robot: g1`. A card
without an ONNX is valid but renders a metadata-only page.

**The robot falls on some clips.** Expected for motions outside the policy's
training distribution (e.g. floor-recovery or acrobatics on a locomotion policy).
The gallery leads with reliable clips and keeps guaranteed-fallers off the wall;
all clips remain selectable on the per-policy page.

**My motion looks rotated or scrambled.** The reference stream is MuJoCo Z-up,
quaternion `(w,x,y,z)`; the engine handles the Z-up → three.js Y-up conversion, so
do **not** pre-rotate your data. Regenerate with the exporter — see
[`REFERENCE_STREAM.md`](REFERENCE_STREAM.md).

**`robot` / `config.yaml` mismatch.** Your manifest's `robot` should match the
exporter's `robot_id` in `config.yaml`. The exporter keeps these aligned for you.
