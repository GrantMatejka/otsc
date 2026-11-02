import { safeParseAsync, type $ZodType } from "zod/v4/core";
import { parseJsonSequence, parseNdjson, parseSse, streamBytes } from "./streaming/index.js";

export function decodeStreamResponse(
  data: unknown,
  format: "ndjson" | "json-seq" | "sse" | "binary",
  schema: $ZodType | undefined,
  options: { validate: boolean; transform: boolean; signal?: AbortSignal },
): AsyncIterable<unknown> {
  const parsed = format === "ndjson" ? parseNdjson(data, options)
    : format === "json-seq" ? parseJsonSequence(data, options)
      : format === "sse" ? parseSse(data, options)
        : streamBytes(data, options);
  if (!schema || !options.validate) return parsed;
  return (async function* () {
    for await (const item of parsed) {
      const result = await safeParseAsync(schema, item);
      if (!result.success) throw result.error;
      yield options.transform ? result.data : item;
    }
  })();
}
