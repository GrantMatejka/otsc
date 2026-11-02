import type { AnyOtscRequestOptions, OtscEndpointDefinition } from "./otsc.types.js";
import type { ReadonlyDeep } from "./utils.types.js";
import { OtscError } from "./otsc-error.js";
import { streamBytes } from "./streaming/index.js";
import { AxiosHeaders } from "axios";
import { mediaMatchScore } from "./media.js";

export function responseContentType(headers: unknown): unknown {
  return AxiosHeaders.from(headers as Record<string, string> | undefined).get("Content-Type");
}

export async function bufferStreamResponse(
  endpoint: OtscEndpointDefinition,
  config: ReadonlyDeep<AnyOtscRequestOptions>,
  response: { status: number; data: unknown; headers?: Record<string, unknown> },
) {
  if (response.status === 204 || response.status === 205 || endpoint.method.toLowerCase() === "head") {
    response.data = undefined;
    return;
  }
  const maxLength = config.maxContentLength;
  const checkLength = (length: number) => {
    if (typeof maxLength === "number" && maxLength >= 0 && length > maxLength) {
      throw new OtscError(`Otsc: Response exceeds maxContentLength of ${maxLength} bytes`, config);
    }
  };
  if (!(response.data instanceof ArrayBuffer) && !ArrayBuffer.isView(response.data)) {
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of streamBytes(response.data, { signal: config.signal as AbortSignal | undefined })) {
      length += chunk.byteLength;
      checkLength(length);
      // Producers may reuse their chunk buffers after the next read.
      if (chunk.byteLength) chunks.push(Uint8Array.from(chunk));
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    response.data = bytes;
  } else {
    checkLength(response.data.byteLength);
  }
  decodeBufferedResponse(endpoint, config, response);
}

/** Decode buffered responses according to their actual media type before plugins run. */
export function decodeBufferedResponse(
  endpoint: OtscEndpointDefinition,
  config: ReadonlyDeep<AnyOtscRequestOptions>,
  response: { status: number; data: unknown; headers?: Record<string, unknown> },
  decodeText = false,
) {
  if (response.status === 204 || response.status === 205 || endpoint.method.toLowerCase() === "head") {
    response.data = undefined;
    return;
  }
  const data = response.data;
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data)
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : undefined;
  const contentType = responseContentType(response.headers);
  const media = typeof contentType === "string" ? contentType.split(";", 1)[0]!.trim().toLowerCase() : "";
  if (!bytes && !(decodeText && typeof data === "string")) return;
  const decodeBytes = (): string => {
    const match = typeof contentType === "string" ? /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType) : undefined;
    const charset = match?.[1] || match?.[2] || "utf-8";
    try { return new TextDecoder(charset).decode(bytes); }
    catch (cause) { throw new OtscError(`Otsc: Unsupported response charset ${JSON.stringify(charset)}`, config, bytes, cause instanceof Error ? cause : undefined); }
  };
  if (media === "application/json" || media.endsWith("+json")) {
    const raw = bytes ? decodeBytes() : data as string;
    try { response.data = JSON.parse(raw); }
    catch (cause) {
      throw new OtscError(`Otsc: Invalid JSON response from endpoint '${endpoint.method} ${endpoint.path}'`, config, raw, cause instanceof Error ? cause : undefined);
    }
  } else if (bytes && (media.startsWith("text/") || media === "application/xml" || media.endsWith("+xml"))) {
    response.data = decodeBytes();
  } else if (bytes) {
    response.data = bytes;
  }
}

export function findResponseContract(endpoint: OtscEndpointDefinition, status: number, contentType: unknown) {
  const contracts = endpoint.responses;
  if (!contracts) return undefined;
  const statusContracts = [status, `${Math.floor(status / 100)}XX`, "default"]
    .map((selector) => contracts.filter((contract) => contract.status === selector))
    .find((matches) => matches.length > 0);
  if (!statusContracts) return undefined;
  // These responses have no representation to negotiate, even if the
  // description includes a content map or the server omits Content-Type.
  if (status === 204 || status === 205 || endpoint.method.toLowerCase() === "head") return statusContracts[0];
  let best: (typeof statusContracts)[number] | undefined;
  let bestScore: readonly [number, number] | undefined;
  let ambiguous = false;
  for (const contract of statusContracts) {
    const score: readonly [number, number] | undefined = !contract.mediaType ? [0, 0] :
      typeof contentType === "string" ? mediaMatchScore(contract.mediaType, contentType) : undefined;
    if (score && (!bestScore || score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1]))) {
      best = contract;
      bestScore = score;
      ambiguous = false;
    } else if (score && bestScore && score[0] === bestScore[0] && score[1] === bestScore[1]) {
      ambiguous = true;
    }
  }
  if (ambiguous) throw new Error(`Ambiguous response contract for ${status} ${String(contentType ?? "")}`);
  return best;
}
