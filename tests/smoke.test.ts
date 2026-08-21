import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

describe("x402-klyx scaffold", () => {
  it("exports a VERSION string", () => {
    expect(typeof VERSION).toBe("string");
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
