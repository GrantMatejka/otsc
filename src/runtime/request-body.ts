import { AxiosHeaders } from "axios";
import type { OtscEndpointDefinition } from "./otsc.types.js";
import { mediaMatchScore } from "./media.js";

export function selectRequestBody(
  endpoint: OtscEndpointDefinition | undefined,
  headers: unknown,
) {
  const contracts = endpoint?.requestBodies;
  if (!contracts?.length) return undefined;
  const contentType = AxiosHeaders.from(headers as Record<string, string> | undefined).get("Content-Type");
  if (typeof contentType === "string" && contentType) {
    let best: (typeof contracts)[number] | undefined;
    let bestScore: readonly [number, number] | undefined;
    let ambiguous = false;
    for (const contract of contracts) {
      const score = mediaMatchScore(contract.mediaType, contentType);
      if (!score) continue;
      const comparison = bestScore ? score[0] - bestScore[0] || score[1] - bestScore[1] : 1;
      if (comparison > 0) { best = contract; bestScore = score; ambiguous = false; }
      else if (comparison === 0) ambiguous = true;
    }
    if (ambiguous) throw new Error(`Ambiguous request body Content-Type ${JSON.stringify(contentType)}`);
    if (best) return best;
    throw new Error(`No declared request body matches Content-Type ${JSON.stringify(contentType)}`);
  }
  if (contracts.length === 1 && !contracts[0].mediaType.includes("*")) return contracts[0];
  throw new Error("Select a request body media type with the Content-Type header");
}
