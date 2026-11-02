import { z } from "zod";
import { makeApi, parametersBuilder, Otsc, type OtscCookieParamsForEndpoint, type OtscCookieParamsByPath, type OtscCookieParamsByAlias } from "../../src/runtime/index.js";
const codec = z.codec(z.string(), z.number(), { decode: Number, encode: String });
const api = makeApi([{ method: "get", path: "/cookies", alias: "cookies", parameters: [
  { name: "session", type: "Cookie", schema: codec, codecDirection: "encode", serialization: { in: "cookie", name: "session", required: true } },
  { name: "optional", type: "Cookie", schema: z.string().optional(), serialization: { in: "cookie", name: "optional" } },
], response: z.string() }] as const);
const client = new Otsc(api);
client.cookies({ cookies: { session: 1 } });
client.get("/cookies", { cookies: { session: 1, optional: "x" } });
client.request({ method: "get", url: "/cookies", cookies: { session: 1 } });
const endpoint: OtscCookieParamsForEndpoint<typeof api[0]> = { session: 1 };
const path: OtscCookieParamsByPath<typeof api, "get", "/cookies", false> = { session: "1" };
const alias: OtscCookieParamsByAlias<typeof api, "cookies"> = { session: 1 };
const params = parametersBuilder().addCookie("session", z.string()).addCookies({ other: z.number() }).build();
const identity: "Cookie" = params[0].type;
// @ts-expect-error required cookie must be supplied
client.cookies();
// @ts-expect-error cookie codec accepts the schema output
client.cookies({ cookies: { session: "1" } });
void [endpoint, path, alias, identity];

const querystring = makeApi([{ method: "get", path: "/search", response: z.string(), parameters: [
  { name: "query", type: "Query", schema: z.string(), serialization: { in: "querystring", name: "query", mediaType: "application/json" } },
] }] as const);
void querystring;
