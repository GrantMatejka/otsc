import type { GenerationManifest } from "./index.js";

export interface ReferenceLock {
  formatVersion: 1;
  generator: string;
  generatorVersion: string;
  optionsHash: string;
  inputs: readonly { uri: string; sha256: string; baseUri?: string }[];
}

export function createReferenceLock(manifest: GenerationManifest, generatorVersion: string): ReferenceLock {
  return {
    formatVersion: 1,
    generator: manifest.generator,
    generatorVersion,
    optionsHash: manifest.optionsHash,
    inputs: manifest.inputs.map((input) => ({ ...input })).sort((left, right) => left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0),
  };
}

export function verifyReferenceLock(actual: ReferenceLock, expected: unknown): void {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("Invalid reference lock: expected an object");
  const candidate = expected as Partial<ReferenceLock>;
  if (candidate.formatVersion !== 1 || typeof candidate.generator !== "string" || typeof candidate.generatorVersion !== "string" || typeof candidate.optionsHash !== "string" || !Array.isArray(candidate.inputs)) {
    throw new Error("Invalid reference lock: missing or unsupported fields");
  }
  if (candidate.generator !== actual.generator || candidate.generatorVersion !== actual.generatorVersion) throw new Error("Reference lock generator version does not match");
  if (candidate.optionsHash !== actual.optionsHash) throw new Error("Reference lock generator options do not match");
  const expectedInputs = new Map<string, { sha256: string; baseUri?: string }>();
  for (const entry of candidate.inputs) {
    if (!entry || typeof entry.uri !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || (entry.baseUri !== undefined && typeof entry.baseUri !== "string") || expectedInputs.has(entry.uri)) {
      throw new Error("Invalid reference lock: malformed or duplicate input");
    }
    expectedInputs.set(entry.uri, { sha256: entry.sha256, baseUri: entry.baseUri });
  }
  for (const input of actual.inputs) {
    const expectedInput = expectedInputs.get(input.uri);
    if (!expectedInput || expectedInput.sha256 !== input.sha256 || expectedInput.baseUri !== input.baseUri) throw new Error(`Reference lock mismatch for ${input.uri}`);
    expectedInputs.delete(input.uri);
  }
  if (expectedInputs.size) throw new Error(`Reference lock contains missing input ${expectedInputs.keys().next().value}`);
}
