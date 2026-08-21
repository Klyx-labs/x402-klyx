/**
 * Canonical JSON serialization for signing + verifying x402 scheme
 * payloads.
 *
 * A byte-for-byte match is required between what the client library
 * produces and what the Klyx facilitator recomputes when it verifies
 * an attestation — any drift (whitespace, key ordering, escape
 * form) causes signatures to fail silently. This implementation is
 * a mirror of the facilitator's `src/canonicalize.ts` and any change
 * here MUST land on both sides at once.
 *
 * Rules
 * - Alphabetical field order at every nesting level
 * - No whitespace, no trailing commas, no non-canonical escapes
 * - Numeric fields already passed as base-10 strings by callers
 * - Sub-objects follow the same rules recursively
 * - Arrays preserve source order (only object keys sort)
 * - `null` passes through as `null`
 * - `undefined` values are SKIPPED (never emitted) so an unset
 *   optional doesn't produce a `"field":null` in the canonical bytes
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        "canonicalize: non-finite number cannot be canonically serialized",
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ":" + stringify(obj[k]),
    );
    return "{" + parts.join(",") + "}";
  }
  throw new Error(
    `canonicalize: unsupported value of type ${typeof value}`,
  );
}
