import { describe, expect, it } from "vitest";
import axios, { AxiosHeaders } from "axios";
import { z } from "zod";
import { makeApi, Otsc, OtscError } from "../../src/runtime/index.js";

describe("explicit request codec direction", () => {
  it("encodes async body, query, path and header values while preserving legacy transforms", async () => {
    const codec = z.codec(z.string(), z.number(), { decode: async value => Number(value), encode: async value => `n${value}` });
    const api = makeApi([{ method: "post", path: "/:id", alias: "send", parameters: [
      { name: "id", type: "Path", schema: codec, codecDirection: "encode" },
      { name: "q", type: "Query", schema: codec, codecDirection: "encode" },
      { name: "x-test", type: "Header", schema: codec, codecDirection: "encode" },
      { name: "body", type: "Body", schema: codec, codecDirection: "encode" },
      { name: "legacy", type: "Query", schema: z.string().transform(value => value.toUpperCase()) },
    ], response: z.string() }] as const);
    let sent: { url?: string; params?: unknown; data?: unknown; header?: unknown } = {};
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => {
      sent = { url: config.url, params: config.params, data: config.data, header: config.headers.get("x-test") };
      return { data: '"ok"', status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config };
    } }) });
    expect(await client.send(4, { params: { id: 1 }, queries: { q: 2, legacy: "abc" }, headers: { "x-test": 3 } })).toBe("ok");
    expect(sent).toEqual({ url: "/n1", params: { q: "n2", legacy: "ABC" }, data: "n4", header: "n3" });
    await expect(client.send("bad" as never, { params: { id: 1 }, queries: { q: 2, legacy: "abc" }, headers: { "x-test": 3 } })).rejects.toBeInstanceOf(OtscError);
  });

  it("honors disabled request transforms after codec validation", async () => {
    const codec = z.codec(z.string(), z.number(), { decode: Number, encode: String });
    const api = makeApi([{ method: "get", path: "/x", alias: "x", parameters: [
      { name: "q", type: "Query", schema: codec, codecDirection: "encode" },
    ], response: z.string() }] as const);
    let sent: unknown;
    const client = new Otsc(api, { transform: false, axiosInstance: axios.create({ adapter: async config => {
      sent = config.params;
      return { data: '"ok"', status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config };
    } }) });
    await client.x({ queries: { q: 2 } });
    expect(sent).toEqual({ q: 2 });
  });
});
