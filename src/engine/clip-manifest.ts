/**
 * Browsable clip manifest — mirrors wbc-g1-deploy `config/clips/manifest.yaml`.
 *
 * `reference/index.json` holds every exported stream; `reference/manifest.yaml`
 * selects which clips appear in the gallery / clip picker. Pose clips (getup,
 * liedown) are listed separately and are never browsable.
 */

import { load as yamlLoad } from 'js-yaml';
import type { ReferenceClip, ReferenceIndex } from './policy-config';

export interface ClipManifestEntry {
  /** Clip id in reference/index.json (deploy: `name`). */
  name: string;
  /** Optional override; defaults to index lookup by `name`. */
  file?: string;
}

/** Same shape as wbc-g1-deploy clips/manifest.yaml + pose_clips from config.yaml. */
export interface ClipManifest {
  clips: ClipManifestEntry[];
  default?: string;
  pose_clips?: {
    getup?: string;
    liedown?: string;
  };
}

const POSE_ID = /^(getup|liedown|fallandgetup)/i;

export function isPoseClipId(id: string): boolean {
  return POSE_ID.test(id);
}

export function parseClipManifest(text: string): ClipManifest {
  const doc = yamlLoad(text) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') {
    throw new Error('clip manifest: not a YAML mapping');
  }
  const clips = doc.clips as ClipManifestEntry[] | undefined;
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error('clip manifest: clips[] is required');
  }
  for (const c of clips) {
    if (!c?.name) throw new Error('clip manifest: each clip needs name');
  }
  const pose = doc.pose_clips as ClipManifest['pose_clips'] | undefined;
  return {
    clips,
    default: doc.default != null ? String(doc.default) : undefined,
    pose_clips: pose,
  };
}

export async function loadClipManifest(url: string): Promise<ClipManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return parseClipManifest(await res.text());
}

function findClip(index: ReferenceIndex, entry: ClipManifestEntry): ReferenceClip | undefined {
  const byId = index.clips.find((c) => c.id === entry.name);
  if (byId) return byId;
  const file = entry.file ?? `${entry.name}.bin`;
  return index.clips.find((c) => c.file === file || c.id === entry.name);
}

/** Manifest-ordered browsable clips that exist in the reference index. */
export function resolveBrowsableClips(
  index: ReferenceIndex,
  manifest: ClipManifest,
): ReferenceClip[] {
  const out: ReferenceClip[] = [];
  for (const entry of manifest.clips) {
    const clip = findClip(index, entry);
    if (clip) out.push(clip);
    else console.warn(`[manifest] clip "${entry.name}" not in reference index`);
  }
  return out;
}

/** Fallback when no manifest.yaml: all index clips except pose ids. */
export function browsableClipsWithoutManifest(index: ReferenceIndex): ReferenceClip[] {
  return index.clips.filter((c) => !isPoseClipId(c.id));
}

export function defaultBrowsableClip(
  browsable: ReferenceClip[],
  manifest: ClipManifest | null,
): ReferenceClip | undefined {
  if (!browsable.length) return undefined;
  if (manifest?.default) {
    const hit = browsable.find((c) => c.id === manifest.default);
    if (hit) return hit;
  }
  return browsable.find((c) => c.id === 'walk_01') ?? browsable[0];
}

export function poseClipId(
  manifest: ClipManifest | null,
  kind: 'getup' | 'liedown',
): string | null {
  const id = manifest?.pose_clips?.[kind];
  return id ? String(id) : kind === 'getup' ? 'getup_01' : 'liedown_01';
}

export function resolvePoseClip(
  index: ReferenceIndex,
  manifest: ClipManifest | null,
  kind: 'getup' | 'liedown',
): ReferenceClip | undefined {
  const id = poseClipId(manifest, kind);
  if (!id) return undefined;
  return index.clips.find((c) => c.id === id);
}
