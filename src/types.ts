/**
 * Policy manifest types — the frontend contract for `policies/<id>/policy.yaml`.
 *
 * This is the FINAL schema. It is mirrored by the JSON
 * Schema in `policies/policy.schema.json`, which is the authoritative validator
 * used by `src/registry.ts` (build-time, skip+warn) and `npm run validate`
 * (CI, exit non-zero). Keep the two in sync: this file is the TypeScript view of
 * the contract; the `.json` is the machine-checkable view.
 *
 * `policy.yaml` is the HUMAN-AUTHORED metadata + pointers for one policy. It does
 * NOT duplicate the exporter's machine artifacts — it points at them:
 *   • `policy.onnx`  — the trained network (M2 live engine: onnxruntime-web).
 *   • `config.yaml`  — the deploy obs/action layout shipped next to the onnx
 *                      (`schema_version: wbc_tracking_params_v1`); M2 consumes it.
 *   • a clip set     — either inline clip metadata, or a pointer to a
 *                      `motion_library.yaml` (`schema: wbc_motion_library_v1`).
 *   • a thumbnail    — gallery card image.
 * These artifacts are emitted per-policy by the exporter;
 * THIS schema defines the folder contract the exporter must honor.
 *
 * @see policies/README.md          — folder layout + authoring guide
 * @see policies/policy.schema.json  — JSON Schema (authoritative validator)
 * @see docs/demo/exported_config.yaml    — real `config.yaml` shape
 * @see docs/demo/motion_library.yaml      — real `motion_library.yaml` shape
 */

/** Schema version this contract speaks. Bump on breaking manifest changes. */
export const POLICY_MANIFEST_SCHEMA_VERSION = '1' as const;

/**
 * Known skill tags. Authors SHOULD prefer these for consistent gallery
 * filtering, but the schema also permits arbitrary extra tags (free-form), so
 * this is a soft enum — `KnownTag | (string & {})` keeps editor autocomplete on
 * the known set without rejecting new labels.
 */
export type KnownTag =
  | 'walk'
  | 'run'
  | 'sprint'
  | 'jump'
  | 'flip'
  | 'fight'
  | 'dance'
  | 'getup'
  | 'crawl'
  | 'locomotion'
  | 'manipulation'
  | 'sport';

/** A skill/grouping tag. Known tags are suggested; any string is allowed. */
// `(string & {})` preserves literal autocomplete while still accepting any string.
export type PolicyTag = KnownTag | (string & {});

/** External links shown on the policy page. All optional. */
export interface PolicyLinks {
  /** Paper / project page URL. */
  paper?: string;
  /** Source-code / training-recipe URL. */
  code?: string;
  /** W&B (or other) training run URL. */
  runUrl?: string;
}

/**
 * Camera framing for the viewport. Either a named preset, or an explicit
 * pose. The explicit form maps directly onto the Three.js viewport
 * (`camera.position` ← `pos`, `controls.target` ← `target`); see
 * `src/viewer/renderer.ts`. Coordinates are world-space metres, Three.js axes
 * (Y up).
 */
export type CameraPreset = 'default' | 'front' | 'side' | 'top' | 'orbit';
export interface CameraPose {
  /** Camera position `[x, y, z]` in metres. */
  pos: [number, number, number];
  /** Orbit/look-at target `[x, y, z]` in metres. */
  target: [number, number, number];
}
export type PolicyCamera = CameraPreset | CameraPose;

/**
 * A single playback clip, authored inline in the manifest. Used by the gallery
 * playback page for the clip picker + scrubbing.
 */
export interface PolicyClip {
  /** Stable, URL-safe clip id. Matches an entry in the motion library. */
  id: string;
  /** Human label, e.g. "Walk forward". */
  name: string;
  /**
   * Path to the clip's playback data, relative to the policy folder
   * (`policies/<id>/`). Resolved against the policy's base URL at load time.
   * Format is owned by (likely a packed qpos/state trajectory).
   */
  file: string;
  /** Optional per-clip skill tags. */
  tags?: PolicyTag[];
  /** Optional clip length in seconds (drives the scrubber range). */
  durationSec?: number;
}

/**
 * Clips for a policy. Authors pick ONE of two forms (documented in
 * `policies/README.md`):
 *
 *   • `kind: 'inline'`   — a hand-curated list of clips with display metadata.
 *                          Best for a small, named showcase set.
 *   • `kind: 'manifest'` — a pointer to a `motion_library.yaml`-style manifest
 *                          (`schema: wbc_motion_library_v1`) sitting in the
 *                          policy folder. Best for the exporter's bulk output:
 *                          that file already lists every clip id, fps, dataset,
 *                          robot, etc., so we reference it instead of copying
 *                          its contents into `policy.yaml`.
 *
 * The `manifest` form intentionally carries only a `file` pointer (+ optional
 * `default`): per-clip display names/files are resolved from the referenced
 * `motion_library.yaml` at load time, keeping `policy.yaml`
 * free of duplicated clip data.
 */
export type PolicyClips =
  | { kind: 'inline'; clips: PolicyClip[] }
  | {
      /** Pointer to a `motion_library.yaml` manifest in the policy folder. */
      kind: 'manifest';
      /** Path to the motion-library manifest, relative to the policy folder. */
      file: string;
      /** Optional id of the clip to show first (must exist in the library). */
      default?: string;
    };

/**
 * Per-policy artifact pointers. All paths are RELATIVE to the policy folder
 * (`policies/<id>/`) and resolved against the folder's published URL at
 * runtime. These name the machine artifacts the exporter drops
 * next to the manifest — the manifest references them, never inlines them.
 */
export interface PolicyArtifacts {
  /** ONNX policy network, e.g. "policy.onnx" (M2 live engine). */
  onnx: string;
  /**
   * Deploy obs/action config, e.g. "config.yaml"
   * (`schema_version: wbc_tracking_params_v1`). M2 consumes it to wire the
   * observation/action layout. Optional: playback (M1) does not need it.
   */
  config?: string;
  /**
   * Optional Gen params folder (`wbc_gen_deploy_params_v1`), e.g. `gen/params/`.
   * Enables Generator locomotion as an alternate Arc source.
   */
  gen?: string;
  /** Clip set for playback. Optional until clips are produced. */
  clips?: PolicyClips;
}

/**
 * Parsed `policy.yaml` for one policy, as authored by a contributor.
 *
 * Authoring a policy = drop a folder under `policies/<id>/` containing this
 * manifest plus its artifacts (policy.onnx, config.yaml, clips, thumbnail) and
 * open a PR. No code changes required — see `registry.ts`.
 */
export interface PolicyManifest {
  /**
   * Manifest schema version (currently "1"). Lets the loader migrate/reject
   * incompatible manifests as the schema evolves. Required.
   */
  schemaVersion: string;

  /**
   * Optional in-file id. The FOLDER NAME is authoritative for the URL slug and
   * registry id; if present here it is advisory (and SHOULD match the folder).
   */
  id?: string;

  /** Display name shown on the card and policy page. Required. */
  name: string;

  /** One-line summary for the gallery card. Optional. */
  description?: string;

  /**
   * Robot/embodiment id, e.g. "g1". Matches the exporter's `robot_id` in
   * `config.yaml` and `robot` in `motion_library.yaml`. Drives which GLB the
   * viewer loads. Optional until robot meshes exist.
   */
  robot?: string;

  /**
   * Skill/grouping tags for gallery filtering (walk/run/fight/flip/getup/
   * dance/…). Known tags are suggested; arbitrary tags are allowed. Optional.
   */
  tags?: PolicyTag[];

  /** Policy author / contributor name or handle. Optional. */
  author?: string;

  /** External links (paper, code, training run). Optional. */
  links?: PolicyLinks;

  /**
   * Thumbnail image path, relative to the policy folder, e.g. "thumb.png".
   * Shown on the gallery card. Optional.
   */
  thumbnail?: string;

  /**
   * Id of the clip to show first on the policy page. Must match a clip id in
   * `artifacts.clips` (inline) or in the referenced motion library (manifest).
   * Optional; the page falls back to the first available clip.
   */
  defaultClip?: string;

  /** Camera framing for the viewport: a named preset or an explicit pose. */
  camera?: PolicyCamera;

  /**
   * Pointers to the policy's machine artifacts (onnx, config, clips). Optional
   * for an M1 metadata-only card, but required for the M2 live engine. */
  artifacts?: PolicyArtifacts;
}

/**
 * A discovered policy: its parsed manifest plus build-time-resolved metadata
 * that the manifest itself does not carry (folder id, base URL for resolving
 * relative artifact paths). Produced by `registry.ts`.
 */
export interface PolicyEntry {
  /** Folder-derived id (always present, even if the manifest omits `id`). */
  id: string;
  /** The parsed, schema-validated manifest. */
  manifest: PolicyManifest;
  /**
   * Base URL for this policy's folder, already prefixed with Vite's `base`.
   * Resolve manifest-relative paths (clips, thumbnail, onnx, config) against
   * this.
   */
  baseUrl: string;
}
