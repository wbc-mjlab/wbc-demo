/**
 * `npm run validate` — validate every policy manifest against the schema.
 *
 * Walks `policies/<id>/policy.yaml`, parses each with js-yaml, and validates it
 * against `policies/policy.schema.json` via the shared validator. Prints a
 * per-file PASS/FAIL summary and exits NON-ZERO if any manifest is invalid (or
 * unparseable). This is the gate CI runs (issue wbc-mjlab-2of).
 *
 * Run with tsx (a TypeScript runner) so it can share `src/validate-manifest.ts`
 * with the frontend — one schema, one validator, no drift.
 *
 * Usage:  npm run validate
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import { validateManifest } from '../src/validate-manifest';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..');
const POLICIES_DIR = join(PROJECT_ROOT, 'policies');

/** All `policies/<id>/policy.yaml` paths (any folder, including `_example`). */
function findManifests(): string[] {
  const out: string[] = [];
  for (const name of readdirSync(POLICIES_DIR)) {
    const dir = join(POLICIES_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifest = join(dir, 'policy.yaml');
    try {
      if (statSync(manifest).isFile()) out.push(manifest);
    } catch {
      // Folder without a policy.yaml — flag it as a failure below.
      out.push(manifest);
    }
  }
  return out.sort();
}

function rel(p: string): string {
  return relative(PROJECT_ROOT, p);
}

function main(): void {
  const manifests = findManifests();

  if (manifests.length === 0) {
    console.error('No policies/<id>/policy.yaml files found. Nothing to validate.');
    process.exit(1);
  }

  let failures = 0;

  for (const path of manifests) {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      console.error(`FAIL ${rel(path)}\n  - missing policy.yaml`);
      failures++;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = loadYaml(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`FAIL ${rel(path)}\n  - YAML parse error: ${msg}`);
      failures++;
      continue;
    }

    const result = validateManifest(parsed);
    if (result.valid) {
      console.log(`PASS ${rel(path)}`);
    } else {
      console.error(`FAIL ${rel(path)}\n  - ${result.messages.join('\n  - ')}`);
      failures++;
    }
  }

  const total = manifests.length;
  console.log(`\n${total - failures}/${total} manifest(s) valid.`);

  if (failures > 0) {
    console.error(`${failures} manifest(s) failed validation.`);
    process.exit(1);
  }
}

main();
