import { z } from "zod";
import { makeApi, type OtscOptions } from "../../src/runtime/index.js";
const options: OtscOptions = { credentials: {
  apiKey: "secret",
  basic: { username: "user", password: "password" },
  token: async () => "token",
  optional: () => undefined,
  dynamicBasic: () => Promise.resolve({ username: "user", password: "password" }),
} };
const api = makeApi([{ method: "get", path: "/private", response: z.string(),
  security: [{ apiKey: [], token: ["read"] }, {}],
  securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" }, token: { type: "http", scheme: "bearer" } },
}] as const);
// @ts-expect-error credentials must be strings, basic credentials, or providers
const invalid: OtscOptions = { credentials: { token: 42 } };
void [options, api, invalid];
