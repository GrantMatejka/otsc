import { describe, expect, it } from "vitest";
import { createReferenceLock, verifyReferenceLock } from "../../src/generator/lock.js";
import type { GenerationManifest } from "../../src/generator/index.js";

const manifest: GenerationManifest = {
  formatVersion: 1,
  generator: "otsc",
  optionsHash: "options",
  inputs: [
    { uri: "remote.json", sha256: "b".repeat(64) },
    { uri: "root", sha256: "a".repeat(64) },
  ],
  outputs: [],
};

describe("reference locks", () => {
  it("sorts inputs and verifies identical frozen inputs", () => {
    const lock = createReferenceLock(manifest, "0.1.0");
    expect(lock.inputs.map((input) => input.uri)).toEqual(["remote.json", "root"]);
    expect(() => verifyReferenceLock(lock, JSON.parse(JSON.stringify(lock)))).not.toThrow();
  });

  it("rejects changed, missing, duplicate, malformed, and configuration inputs", () => {
    const lock = createReferenceLock(manifest, "0.1.0");
    expect(() => verifyReferenceLock(lock, { ...lock, generatorVersion: "other" })).toThrow("version");
    expect(() => verifyReferenceLock(lock, { ...lock, optionsHash: "other" })).toThrow("options");
    expect(() => verifyReferenceLock(lock, { ...lock, inputs: [{ uri: "root", sha256: "c".repeat(64) }] })).toThrow("mismatch");
    expect(() => verifyReferenceLock(lock, { ...lock, inputs: [...lock.inputs, { uri: "extra", sha256: "d".repeat(64) }] })).toThrow("missing input");
    expect(() => verifyReferenceLock(lock, { ...lock, inputs: [lock.inputs[0], lock.inputs[0]] })).toThrow("duplicate");
    expect(() => verifyReferenceLock(lock, { ...lock, inputs: [{ uri: "root", sha256: "invalid" }] })).toThrow("malformed");
  });
});
