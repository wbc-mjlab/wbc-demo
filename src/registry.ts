/**
 * Policy registry — build-time discovery of policies.
 *
 * Policies live under `policies/<id>/policy.yaml` (+ artifacts). This module
 * uses Vite's `import.meta.glob` to find every committed manifest at BUILD
 * TIME, parses it with js-yaml, and exposes a typed list. The upshot:
 *
 *     adding a policy = drop `policies/<id>/policy.yaml` (+ artifacts) → PR.
 *     No code edits here.
 *
 * @see policies/README.md         — folder layout
 * @see types.ts                   — manifest shape (wbc-mjlab-0d8, final)
 * @see policies/policy.schema.json — schema validated against here
 */

// js-yaml v5 is pure ESM with named exports (no default export).
import { load as loadYaml } from 'js-yaml';
import type { PolicyEntry, PolicyManifest } from './types';
import { validateManifest } from './validate-manifest';

/**
 * Eagerly import every policy manifest as a raw string. The glob is relative to
 * THIS file (`src/`), so it climbs one level into `policies/`. `eager: true`
 * inlines the matches at build time; `query: '?raw'` gives us the file text so
 * we can parse it ourselves with js-yaml (Vite has no built-in YAML loader).
 *
 * The `_example/` folder is intentionally NOT excluded here — it is filtered in
 * `discoverPolicies()` so reviewers can see exactly where the example drops out.
 */
const manifestModules = import.meta.glob('../policies/*/policy.yaml', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

/** Folder id of the throwaway example shipped so the gallery renders something. */
const EXAMPLE_ID = '_example';

/** Extract the `<id>` segment from `../policies/<id>/policy.yaml`. */
function folderIdFromPath(path: string): string {
  const match = path.match(/\/policies\/([^/]+)\/policy\.yaml$/);
  if (!match?.[1]) {
    throw new Error(`Unexpected policy manifest path: ${path}`);
  }
  return match[1];
}

/**
 * Build the public base URL for a policy folder, prefixed with Vite's `base`
 * (e.g. `/wbc-demo/` → `/wbc-demo/policies/<id>/`). Manifest-relative artifact
 * paths (thumbnail, clips, onnx) resolve against this at runtime.
 *
 * ⚠️ EMISSION CAVEAT (for wbc-mjlab-3ne / M2): manifests are INLINED at build
 * time (see the glob above), but Vite does NOT copy the root-level `policies/`
 * tree into `dist/` — only `public/` is copied verbatim. So the *other*
 * artifacts (thumbnails, clips, onnx) are NOT yet served at the URLs returned
 * here. When those features land, make the artifacts emittable — simplest is to
 * have the build copy `policies/` into the output (e.g. a tiny Vite plugin or
 * `vite-plugin-static-copy`), or move per-policy assets under `public/`. No
 * real artifacts exist today, so nothing is broken yet.
 */
function policyBaseUrl(id: string): string {
  return `${import.meta.env.BASE_URL}policies/${id}/`;
}

/**
 * Discover all committed policies. Parses + validates each manifest against
 * `policies/policy.schema.json`. Invalid manifests are SKIPPED with a clear
 * console warning rather than crashing the whole gallery (one bad PR shouldn't
 * take the site down). The same schema is enforced hard by `npm run validate`
 * in CI, so invalid manifests should never reach `main`.
 *
 * @param includeExample keep the removable `_example` policy (default: true so
 *   the gallery is never empty before real policies land).
 */
export function discoverPolicies(includeExample = true): PolicyEntry[] {
  const entries: PolicyEntry[] = [];

  for (const [path, raw] of Object.entries(manifestModules)) {
    const id = folderIdFromPath(path);
    if (id === EXAMPLE_ID && !includeExample) continue;

    let parsed: unknown;
    try {
      parsed = loadYaml(raw);
    } catch (err) {
      console.warn(`[registry] Failed to parse ${path}:`, err);
      continue;
    }

    const result = validateManifest(parsed);
    if (!result.valid) {
      console.warn(
        `[registry] Skipping ${path}: invalid manifest:\n  - ${result.messages.join('\n  - ')}`,
      );
      continue;
    }

    // Validated against the schema above, so `parsed` is a PolicyManifest.
    // Folder name is authoritative for the id (manifest `id` is advisory); we
    // override it so URLs stay stable regardless of the manifest's own `id`.
    const manifest: PolicyManifest = { ...(parsed as PolicyManifest), id };

    entries.push({ id, manifest, baseUrl: policyBaseUrl(id) });
  }

  // Stable ordering: example last, then alphabetical by display name.
  entries.sort((a, b) => {
    if (a.id === EXAMPLE_ID) return 1;
    if (b.id === EXAMPLE_ID) return -1;
    return a.manifest.name.localeCompare(b.manifest.name);
  });

  return entries;
}

/** Look up a single policy by its folder id. */
export function getPolicy(id: string): PolicyEntry | undefined {
  return discoverPolicies().find((p) => p.id === id);
}
