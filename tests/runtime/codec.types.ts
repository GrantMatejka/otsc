import { z } from "zod";
import { makeApi, Otsc, type OtscBodyForEndpoint, type OtscBodyByPath, type OtscBodyByAlias, type OtscQueryParamsByAlias, type OtscPathParamByAlias } from "../../src/runtime/index.js";
const codec = z.codec(z.string(), z.number(), { decode: Number, encode: String });
const api = makeApi([{ method: "post", path: "/:id", alias: "send", parameters: [
  { name: "id", type: "Path", schema: codec, codecDirection: "encode" },
  { name: "q", type: "Query", schema: codec, codecDirection: "encode" },
  { name: "body", type: "Body", schema: codec, codecDirection: "encode" },
], response: z.string() }] as const);
const client = new Otsc(api);
client.send(1, { params: { id: 2 }, queries: { q: 3 } });
client.post("/:id", 1, { params: { id: 2 }, queries: { q: 3 } });
const frontend: OtscBodyForEndpoint<typeof api[0]> = 1;
const backend: OtscBodyForEndpoint<typeof api[0], false> = "1";
const byPath: OtscBodyByPath<typeof api, "post", "/:id"> = 1;
const byAlias: OtscBodyByAlias<typeof api, "send"> = 1;
const query: OtscQueryParamsByAlias<typeof api, "send", false> = { q: "1" };
const path: OtscPathParamByAlias<typeof api, "send", false> = { id: "1" };
// @ts-expect-error codec body accepts application output
client.send("1", { params: { id: 2 }, queries: { q: 3 } });
// @ts-expect-error codec query accepts application output
client.send(1, { params: { id: 2 }, queries: { q: "3" } });
// @ts-expect-error codec path accepts application output
client.send(1, { params: { id: "2" }, queries: { q: 3 } });
void [frontend, backend, byPath, byAlias, query, path];
