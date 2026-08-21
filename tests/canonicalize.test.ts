import { describe, it, expect } from "vitest";
import { canonicalize } from "../src/core/canonicalize.js";

describe("canonicalize", () => {
  it("sorts object keys alphabetically at every nesting level", () => {
    const input = {
      z: 1,
      a: { c: 2, b: { y: 3, x: 4 } },
    };
    expect(canonicalize(input)).toBe(
      '{"a":{"b":{"x":4,"y":3},"c":2},"z":1}',
    );
  });

  it("preserves array order (arrays don't sort)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("skips undefined values (does not emit as null)", () => {
    const input = { a: 1, b: undefined, c: 3 };
    expect(canonicalize(input)).toBe('{"a":1,"c":3}');
  });

  it("emits null for null values", () => {
    expect(canonicalize({ x: null })).toBe('{"x":null}');
    expect(canonicalize(null)).toBe("null");
  });

  it("emits booleans as true/false", () => {
    expect(canonicalize({ ok: true, bad: false })).toBe(
      '{"bad":false,"ok":true}',
    );
  });

  it("emits strings with standard JSON escaping", () => {
    expect(canonicalize({ s: 'quote"' })).toBe('{"s":"quote\\""}');
    expect(canonicalize({ s: "back\\slash" })).toBe(
      '{"s":"back\\\\slash"}',
    );
  });

  it("throws on non-finite numbers", () => {
    expect(() => canonicalize({ x: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalize({ x: NaN })).toThrow(/non-finite/);
  });

  it("throws on unsupported value types (symbol/function)", () => {
    expect(() => canonicalize({ s: Symbol("x") })).toThrow(
      /unsupported/,
    );
    expect(() => canonicalize({ f: () => 1 })).toThrow(/unsupported/);
  });

  it("is deterministic across differing insertion order", () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it("handles nested arrays of objects with sorted keys", () => {
    const input = [
      { z: 1, a: 2 },
      { b: 3, a: 4 },
    ];
    expect(canonicalize(input)).toBe('[{"a":2,"z":1},{"a":4,"b":3}]');
  });

  it("produces the same bytes as the facilitator would for a klever-exact payload minus attestation", () => {
    // This is the exact shape the Klyx facilitator's
    // `canonicalizeForAttestation` produces. If this test drifts,
    // wallet-signed attestations will silently fail verification.
    const payload = {
      asset: "KLV",
      amount: "500000",
      destination: "klv1provider0000000000000000000000000000000",
      nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      expiresAt: "2030-01-01T00:00:00Z",
      authorization: {
        signer: "klv1requester0000000000000000000000000000000",
        publicKey: "1111111111111111111111111111111111111111111111111111111111111111",
      },
    };
    expect(canonicalize(payload)).toBe(
      '{"amount":"500000","asset":"KLV","authorization":{"publicKey":"1111111111111111111111111111111111111111111111111111111111111111","signer":"klv1requester0000000000000000000000000000000"},"destination":"klv1provider0000000000000000000000000000000","expiresAt":"2030-01-01T00:00:00Z","nonce":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    );
  });
});
