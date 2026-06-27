# Contributing — add a policy to the demo

This repo is **data-driven**: the gallery is built from whatever policy folders
are committed under [`policies/`](policies/). Publishing a new trained policy is
a **content PR, not a code change** — drop a folder, fill one manifest, open a
PR. The build discovers it and renders a card + a per-policy page automatically.

This guide is the end-to-end path from a trained checkpoint in
[`wbc-mjlab`](https://github.com/wbc-mjlab) to a live card in the demo.

> Looking for the field-by-field manifest reference? That lives in
> [`policies/README.md`](policies/README.md). The authoritative contract is
> [`policies/policy.schema.json`](policies/policy.schema.json), mirrored by
> `PolicyManifest` in [`src/types.ts`](src/types.ts).

---

## TL;DR

```bash
# 1. in wbc-mjlab — export a ready-to-drop folder (recommended path)
wbc-mjlab-export-web-policy --run <run> --out wbc-demo/policies/<policy-id>

# 2. in wbc-demo — validate + preview
npm install
npm run validate            # must PASS
npm run dev                 # eyeball the gallery + policy page

# 3. open a PR. CI re-runs validate + build; merge to main deploys.
```

`<policy-id>` is lowercase **kebab-case** and becomes the URL slug
(`policy.html?id=<policy-id>`).

---

## 1. Train + export in wbc-mjlab

### Recommended: `wbc-mjlab-export-web-policy`

In `wbc-mjlab`, run the exporter (issue **wbc-mjlab-5uw**) against a trained run.
It emits a **ready-to-drop** `policies/<policy-id>/` folder with everything the
demo needs, already wired to the manifest contract:

```
policies/<policy-id>/
  policy.onnx           # the trained network (M2 live engine: onnxruntime-web)
  config.yaml           # deploy obs/action layout (schema_version: wbc_tracking_params_v1)
  motion_library.yaml   # clip-library manifest (schema: wbc_motion_library_v1)
  clips/                # recorded playback clips (see CLIP_FORMAT.md)
  thumb.png             # gallery thumbnail
  policy.yaml           # the MANIFEST — pre-filled, ready to edit
```

The exporter writes a `policy.yaml` that already points at the artifacts it just
produced. You normally only need to **edit the human metadata** (name,
description, tags, links) before committing — see step 3.

Point it straight at your checkout so the folder lands in the right place:

```bash
wbc-mjlab-export-web-policy --run <run> --out /path/to/wbc-demo/policies/<policy-id>
```

> Exact CLI flags are owned by **wbc-mjlab-5uw** — check that command's `--help`
> for the current interface. The folder *layout* above is the contract this repo
> guarantees.

### Manual: assemble the folder by hand

If you're not using the exporter (e.g. an older checkpoint, or you only want a
metadata card for now), build the same folder yourself. The only artifact that
makes a card appear in the gallery is `policy.yaml` — everything else powers
features that are still landing (playback, the live engine), so you can add a
metadata-only card and fill in artifacts later.

```
policies/<policy-id>/
  policy.yaml           # required — the manifest (step 3)
  policy.onnx           # the trained network, exported to ONNX
  config.yaml           # deploy obs/action config (wbc_tracking_params_v1)
  thumb.png             # optional gallery thumbnail
  clips/                # optional — playback clips, format below
  motion_library.yaml   # optional — if you use the "manifest" clip form
```

Clips must follow the **`wbc_web_clips_v1`** wire format — raw little-endian
Float32 body world poses plus a `clips/index.json`. The full spec (body order,
frame layout, the MuJoCo-Z-up → three.js-Y-up convention) is in
[`CLIP_FORMAT.md`](CLIP_FORMAT.md). Pose order/body count come from
[`public/robots/<robot>/<robot>.bodies.json`](public/robots/g1/README.md).

---

## 2. Drop the folder

Place the folder under `policies/<policy-id>/`:

- `<policy-id>` is the **folder name** — it is the authoritative id and the URL
  slug. Use **lowercase kebab-case** (`^[a-z0-9][a-z0-9-]*$`), e.g.
  `g1-sprint`, `tracking-v2`.
- Artifacts are **committed directly to this repo** (no external storage, no
  Git LFS today). The robot mesh GLB is shared across policies and already lives
  in [`public/robots/`](public/robots/) — you do **not** ship it per policy.

---

## 3. Fill `policy.yaml`

`policy.yaml` is **human-authored metadata + pointers**. It references the
machine artifacts in the folder — it never duplicates their contents. Only
`schemaVersion` and `name` are required.

A minimal, copy-pasteable starting point:

```yaml
schemaVersion: "1"            # required — manifest schema version (currently "1")
name: "G1 Sprint"             # required — display name on the card + page
description: "High-speed forward locomotion on flat ground."
robot: "g1"                   # embodiment id; selects the robot GLB (wbc-mjlab-9as)
tags: ["sprint", "run", "locomotion"]
author: "your-handle"
links:
  paper: "https://example.com/paper"
  code: "https://github.com/wbc-mjlab/wbc-mjlab"
  runUrl: "https://wandb.ai/<entity>/<project>/runs/<id>"
thumbnail: "thumb.png"        # relative to this folder
defaultClip: "walk-forward"   # clip id to show first
camera: "default"             # preset, or an explicit { pos, target } pose
artifacts:
  onnx: "policy.onnx"         # required inside `artifacts`
  config: "config.yaml"
  clips:
    kind: inline              # pick ONE clip form — see below
    clips:
      - id: "walk-forward"
        name: "Walk forward"
        file: "clips/walk-forward.bin"
        tags: ["walk"]
        durationSec: 4.0
```

Field-by-field:

| Field | Req | What it does |
| --- | --- | --- |
| `schemaVersion` | yes | Manifest schema version. Currently `"1"`. |
| `name` | yes | Display name on the card and policy page. |
| `id` | — | Advisory only; the **folder name** is authoritative. Omit it or match the folder. |
| `description` | — | One-line summary for the gallery card. |
| `robot` | — | Embodiment id, e.g. `"g1"`. Selects the robot GLB the viewer loads (wbc-mjlab-9as). Matches `config.yaml`'s `robot_id`. |
| `tags` | — | Skill/grouping tags for gallery filtering. Known set below; arbitrary tags allowed. |
| `author` | — | Your name or handle. |
| `links` | — | `{ paper?, code?, runUrl? }` — all optional URLs, surfaced on the policy page. |
| `thumbnail` | — | Card image path, relative to the folder, e.g. `"thumb.png"`. |
| `defaultClip` | — | Clip id to show first; falls back to the first available clip if omitted. |
| `camera` | — | A preset (`default` / `front` / `side` / `top` / `orbit`) **or** an explicit `{ pos: [x,y,z], target: [x,y,z] }` pose (metres, three.js axes, Y up). |
| `artifacts` | — | Pointers to the machine artifacts. Required for the M2 live engine; optional for a metadata-only card. |

Inside `artifacts`: `onnx` is required (e.g. `"policy.onnx"`), `config` is
optional (consumed by the M2 engine), and `clips` is optional.

**Known tags** (preferred for consistent filtering; any string is still
accepted): `walk`, `run`, `sprint`, `jump`, `flip`, `fight`, `dance`, `getup`,
`crawl`, `locomotion`, `manipulation`, `sport`.

### Clips — pick ONE form

**(A) inline** — a small, hand-curated showcase set with display metadata:

```yaml
artifacts:
  clips:
    kind: inline
    clips:
      - id: "walk-forward"
        name: "Walk forward"
        file: "clips/walk-forward.bin"   # relative to the policy folder
        tags: ["walk"]                    # optional
        durationSec: 4.0                  # optional
```

**(B) manifest** — point at the exporter's `motion_library.yaml`
(`schema: wbc_motion_library_v1`) and let per-clip names/files resolve from it at
load time. Best for the exporter's bulk output — don't copy the clip list into
`policy.yaml`:

```yaml
artifacts:
  clips:
    kind: manifest
    file: "motion_library.yaml"
    default: "walk1_subject1"   # optional; clip id from the library
```

> All manifest paths (`thumbnail`, `artifacts.onnx`, `artifacts.config`, clip
> `file`s) are **relative to the policy folder**. Absolute paths and `..`
> escapes are rejected by the schema.

The canonical, fully-commented manifest is
[`policies/_example/policy.yaml`](policies/_example/policy.yaml).

---

## 4. Validate locally

```bash
npm install        # first time only (Node ≥ 20.19 or ≥ 22.12, per Vite 8)
npm run validate   # validates EVERY policies/*/policy.yaml against the schema
```

`npm run validate` prints a per-file `PASS`/`FAIL` summary and exits non-zero on
any failure. **It must pass before you open a PR** — CI runs the exact same gate.
It checks the manifest *text* against the schema; it does **not** check that the
files you point at actually exist, so double-check artifact paths yourself.

Preview the result:

```bash
npm run dev        # Vite dev server at http://localhost:5173/wbc-demo/
# ...or build + serve the production bundle:
npm run build      # tsc --noEmit + vite build into dist/
npm run preview
```

Open the gallery, confirm your card shows up, and click into the policy page.
The `/wbc-demo/` prefix in the URL is intentional — it matches the GitHub Pages
base path set in `vite.config.ts`.

---

## 5. Open a PR

Commit the new `policies/<policy-id>/` folder and open a pull request.

- **CI** (issue **wbc-mjlab-2of**) runs `npm run validate` + `npm run build` on
  the PR. The build also skips-and-warns on any invalid manifest, so one bad
  manifest can't take the whole gallery down — but a `validate` failure is a
  hard gate, so green CI = your manifest is well-formed.
- **On merge to `main`**, [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)
  builds the site and publishes `dist/` to GitHub Pages.

> Heads-up: GitHub Pages activates once the repo is made public (tracked
> separately). Until then a merge builds and uploads the Pages artifact but the
> public URL isn't live yet — don't assume your policy is publicly viewable the
> moment it merges.

If you added the **first** real policy, you can delete the
`policies/_example/` placeholder in the same PR (the registry sorts it last and
only keeps it so the gallery isn't empty).

---

## Troubleshooting / FAQ

**`npm run validate` fails — what do I look at?**
The output names the file and the failing rule. Common causes:
- `schemaVersion` not the string `"1"` (it's a quoted string, not a number).
- Unknown field — the schema is **strict** (`additionalProperties: false`), so a
  typo'd key fails. Cross-check against
  [`policies/README.md`](policies/README.md) / the schema.
- `id` / `<policy-id>` not lowercase kebab-case (`^[a-z0-9][a-z0-9-]*$`).
- A path that's absolute or contains `..` — paths must be relative to the folder.
- Both clip forms at once: `clips` is `kind: inline` **or** `kind: manifest`,
  never both.
- A `links.*` value that isn't a valid URL.

**My card shows but the viewport is just a placeholder box.**
Expected for now. The robot meshes (issue **wbc-mjlab-9as**) and clip playback
(issue **wbc-mjlab-3ne**) are still landing; until then the viewport renders a
placeholder. A metadata-only card (no `artifacts`) is valid and will appear in
the gallery.

**Do I ship the robot mesh?**
No. The robot GLB is shared and lives in
[`public/robots/<robot>/`](public/robots/g1/README.md), selected by your
manifest's `robot` field. You ship only your policy's own artifacts.

**My clips don't render / look rotated or scrambled.**
Clips must be **`wbc_web_clips_v1`**: frame-major little-endian Float32, 7 floats
per body (`posX,posY,posZ, quatW,quatX,quatY,quatZ`), MuJoCo Z-up world frame,
quaternion `(w,x,y,z)`. Body order and count must match
`public/robots/<robot>/<robot>.bodies.json` (G1 = 31 bodies, index 0 = `world`).
Read [`CLIP_FORMAT.md`](CLIP_FORMAT.md) carefully — the renderer handles the
Z-up → Y-up conversion, so do **not** pre-rotate your data. Use the exporter to
avoid these pitfalls.

**My artifacts are large — is that OK?**
Artifacts are committed directly to git (no LFS today). Keep it reasonable: the
robot mesh is already shipped meshopt-compressed (~2 MB) and shared. ONNX
networks are small; the bulk is clip data. Trim long clips to a representative
showcase rather than dumping an entire training library, and prefer the
`manifest` clip form so `policy.yaml` stays lean.

**`robot` / `config.yaml` mismatch.**
Your manifest's `robot` should match the exporter's `robot_id` in `config.yaml`
and `robot` in `motion_library.yaml`. If they disagree, the viewer may load the
wrong GLB (or none). The exporter keeps these aligned for you.

---

## Related issues

- **wbc-mjlab-0d8** — the manifest schema (`policy.schema.json` + `src/types.ts`).
- **wbc-mjlab-5uw** — the `wbc-mjlab-export-web-policy` exporter.
- **wbc-mjlab-2of** — CI: `npm run validate` + build gate.
- **wbc-mjlab-3ne** — clip playback rendering.
- **wbc-mjlab-9as** — robot meshes (GLB + `bodies.json`).
- **M2** — live in-browser engine (mujoco-wasm + onnxruntime-web).
