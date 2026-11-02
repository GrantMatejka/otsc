import * as mini from "zod/mini";
import { makeApi, makeEndpoint, makeErrors, makeParameters, makeCrudApi, parametersBuilder, Otsc, isErrorFromAlias, type OtscBodyByAlias, type OtscResponseByAlias } from "../../src/runtime/index.js";
const body = mini.pipe(mini.string(), mini.transform((value: string) => Number(value)));
const params = parametersBuilder().addBody(body).addQuery("q", mini.string()).build();
const sameBody: typeof body = params[0].schema;
const separate = makeParameters([{ name: "q", type: "Query", schema: mini.string() }] as const);
const errors = makeErrors([{ status: 400, schema: body }] as const);
const endpoint = makeEndpoint({ method: "post", path: "/x", alias: "create", parameters: params, errors, response: body } as const);
const api = makeApi([endpoint] as const);
const client = new Otsc(api);
const result: Promise<number> = client.create("12", { queries: { q: "query" } });
const input: OtscBodyByAlias<typeof api, "create"> = "1";
const output: OtscResponseByAlias<typeof api, "create"> = 1;
// @ts-expect-error body takes the Mini schema input type
client.create(12, { queries: { q: "query" } });
// @ts-expect-error query is required
client.create("12", {});
declare const error: unknown;
if (isErrorFromAlias(api, "create", error)) {
  const wireData: string = error.response.data;
  // @ts-expect-error guard does not replace wire data with transformed output
  const decodedData: number = error.response.data;
  void [wireData, decodedData];
}
void [sameBody, separate, result, input, output];

const crud = makeCrudApi("item", mini.object({ name: mini.string() }));
void crud;
