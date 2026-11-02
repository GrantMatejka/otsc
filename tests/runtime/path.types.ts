import { z } from "zod";
import { makeApi, Otsc, type OtscPathParamsForEndpoint, type OtscPathParamsByPath, type OtscPathParamByAlias } from "../../src/runtime/index.js";

const api = makeApi([
  { method: "get", path: "/:first-thing.:second", originalPath: "/{first-thing}.{second}", alias: "mixed", parameters: [
    { name: "first-thing", type: "Path", schema: z.string() },
    { name: "second", type: "Path", schema: z.number() },
  ], response: z.string() },
  { method: "get", path: "/legacy/:id", alias: "legacy", response: z.string() },
  { method: "get", path: "/fallback/:id", originalPath: "/fallback/{id}", alias: "fallback", response: z.string() },
] as const);
const client = new Otsc(api);
const params = { "first-thing": "first", second: 2 };
const byEndpoint: OtscPathParamsForEndpoint<typeof api[0]> = params;
const byPath: OtscPathParamsByPath<typeof api, "get", "/:first-thing.:second"> = params;
const byAlias: OtscPathParamByAlias<typeof api, "mixed"> = params;
client.mixed({ params });
client.get("/:first-thing.:second", { params });
// @ts-expect-error the second declared parameter remains required
client.mixed({ params: { "first-thing": "first" } });
// @ts-expect-error the schema for second requires a number
client.get("/:first-thing.:second", { params: { "first-thing": "first", second: "2" } });
// @ts-expect-error generated endpoints do not acquire an extra phantom path key
const phantom: OtscPathParamsForEndpoint<typeof api[0]> = { ...params, "first-thing.": "extra" };
client.legacy({ params: { id: "abc" } });
client.fallback({ params: { id: 1 } });
// @ts-expect-error legacy inference still requires id
client.legacy({ params: {} });
void [byEndpoint, byPath, byAlias, phantom];
