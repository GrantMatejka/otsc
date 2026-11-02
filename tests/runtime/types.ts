import { z } from "zod";
import { makeApi, Otsc, type OtscResponseByAlias, type OtscBodyByAlias } from "../../src/runtime/index.js";
const api = makeApi([{ method: "post", path: "/items/:id", alias: "create", parameters: [
  { name: "id", type: "Path", schema: z.string() },
  { name: "body", type: "Body", schema: z.string().transform(Number) },
], response: z.string().transform(Number) }] as const);
const client = new Otsc(api);
const result: Promise<number> = client.create("12", { params: { id: "a" } });
const body: OtscBodyByAlias<typeof api, "create"> = "12";
const response: OtscResponseByAlias<typeof api, "create"> = 12;
// @ts-expect-error body is the Zod input, not its output
client.create(12, { params: { id: "a" } });
// @ts-expect-error path parameter is required
client.create("12", {});
// @ts-expect-error response is transformed to number
const invalid: OtscResponseByAlias<typeof api, "create"> = "12";
void [result, body, response, invalid];
