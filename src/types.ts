/**
 * Policy manifest types.
 *
 * ⚠️ INTERIM SCHEMA — DO NOT TREAT AS FINAL.
 *
 * This is a deliberately minimal shape so the gallery + per-policy page can be
 * built and the build can be verified. The authoritative `policy.yaml` schema
 * is owned by issue **wbc-mjlab-0d8** (manifest schema definition). When that
 * lands, replace/extend the fields below and update `registry.ts`'s parsing &
 * validation to match. Keep this file the single source of truth for the
 * manifest contract in the frontend.
 *
 * @see policies/README.md  — folder layout + authoring guide
 * @see wbc-mjlab-0d8       — finalizes this schema
 */

/** A single recorded playback clip referenced by a policy manifest. */
export interface PolicyClip {
  /** Human label, e.g. "Walk forward". */
  label: string;
  /**
   * Path to the clip artifact, relative to the policy folder
   * (`policies/<id>/`). Resolved against the policy's base URL at load time.
   * Format is TBD by wbc-mjlab-3ne (playback rendering) — likely a packed
   * qpos/state trajectory (.json / .npy-like) or a pre-rendered media file.
   */
  src: string;
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
   * Stable, URL-safe identifier. INTERIM: derived from the folder name in
   * `registry.ts` if the manifest omits it. wbc-mjlab-0d8 will decide whether
   * `id` is required in-file or always folder-derived.
   */
  id: string;

  /** Display name shown on the card and policy page. */
  name: string;

  /** One-line summary for the gallery card. Optional. */
  description?: string;

  /** Free-form tags for grouping/filtering in the gallery. Optional. */
  tags?: string[];

  /**
   * Robot/embodiment name (e.g. "unitree_g1"). Drives which GLB the viewer
   * tries to load. Optional until robot meshes exist (issue wbc-mjlab-9as).
   */
  robot?: string;

  /**
   * Playback clips to make available on the policy page. Optional.
   * Consumed by wbc-mjlab-3ne (playback rendering).
   */
  clips?: PolicyClip[];

  /**
   * Filename of the ONNX policy network within the policy folder, e.g.
   * "policy.onnx". Used by the M2 live engine (onnxruntime-web). Optional now.
   */
  onnx?: string;

  /**
   * Filename of the thumbnail image within the policy folder, e.g.
   * "thumb.png". Shown on the gallery card. Optional.
   */
  thumbnail?: string;
}

/**
 * A discovered policy: its parsed manifest plus build-time-resolved metadata
 * that the manifest itself does not carry (folder id, base URL for resolving
 * relative artifact paths). Produced by `registry.ts`.
 */
export interface PolicyEntry {
  /** Folder-derived id (always present, even if the manifest omits `id`). */
  id: string;
  /** The parsed manifest. */
  manifest: PolicyManifest;
  /**
   * Base URL for this policy's folder, already prefixed with Vite's `base`.
   * Resolve manifest-relative paths (clips, thumbnail, onnx) against this.
   */
  baseUrl: string;
}
