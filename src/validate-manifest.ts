/**
 * Shared manifest validator.
 *
 * Compiles `policies/policy.schema.json` (JSON Schema draft 2020-12) with Ajv
 * and exposes a typed `validateManifest()` used by BOTH:
 *   • `src/registry.ts`        — build-time discovery (skip + warn on invalid).
 *   • `scripts/validate.ts`    — `npm run validate` for CI (exit non-zero).
 *
 * One schema, one validator, two call sites: the gallery and CI can never drift
 * apart. The schema JSON is imported (Vite inlines it; Node reads it as a module
 * via the JSON import assertion in the script), so it ships in the bundle too.
 *
 * @see policies/policy.schema.json — the schema (authoritative contract)
 * @see src/types.ts                — the TypeScript mirror of the same contract
 */

import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import schema from '../policies/policy.schema.json';
import type { PolicyManifest } from './types';

/**
 * Single Ajv instance + compiled validator. `allErrors` so we report every
 * problem in one pass; `ajv-formats` adds the `uri` format used by `links`.
 */
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const validate = ajv.compile(schema) as ValidateFunction<PolicyManifest>;

export interface ValidationResult {
  valid: boolean;
  /** Ajv errors (empty when valid). */
  errors: ErrorObject[];
  /** Human-readable one-line summaries of each error (empty when valid). */
  messages: string[];
}

/** Format one Ajv error as `<instancePath or "(root)"> <message> (<details>)`. */
function formatError(err: ErrorObject): string {
  const where = err.instancePath || '(root)';
  const extra =
    err.keyword === 'additionalProperties' && err.params && 'additionalProperty' in err.params
      ? `: "${(err.params as { additionalProperty: string }).additionalProperty}"`
      : '';
  return `${where} ${err.message ?? 'is invalid'}${extra}`;
}

/**
 * Validate a parsed `policy.yaml` object against the schema.
 *
 * Returns a structured result rather than throwing, so callers choose how to
 * react (registry: warn + skip; CI script: collect + exit non-zero).
 */
export function validateManifest(value: unknown): ValidationResult {
  const valid = validate(value) as boolean;
  const errors = validate.errors ?? [];
  return {
    valid,
    errors,
    messages: errors.map(formatError),
  };
}
