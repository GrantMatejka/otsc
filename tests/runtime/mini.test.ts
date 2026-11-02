import { describe, expect, it } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import * as mini from "zod/mini";
import { Otsc, OtscError, isErrorFromAlias, isErrorFromPath, makeApi, makeCrudApi, parametersBuilder } from "../../src/runtime/index.js";

describe("Zod Mini schemas", () => {
  it("parses async request and response transforms and preserves metadata in builders", async () => {
    const query = mini.pipe(mini.string(), mini.transform(async (value: string) => value.toUpperCase()));
    mini.globalRegistry.add(query, { description: "query description" });
    const parameters = parametersBuilder().addQuery("q", query).build();
    expect(parameters[0].schema).toBe(query);
    expect(parameters[0].description).toBe("query description");
    const api = makeApi([{ method: "get", path: "/mini", alias: "mini", parameters,
      response: mini.pipe(mini.string(), mini.transform(async (value: string) => value.length)) }]);
    let querySent: unknown;
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => {
      querySent = config.params;
      return { data: '"hello"', status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config };
    } }) });
    expect(await client.mini({ queries: { q: "yes" } })).toBe(5);
    expect(querySent).toEqual({ q: "YES" });
    await expect(client.mini({ queries: { q: 1 as never } })).rejects.toMatchObject({ cause: { issues: expect.any(Array) } });
  });

  it("validates modern success and error contracts using Mini", async () => {
    const api = makeApi([{ method: "get", path: "/modern", alias: "modern", response: mini.string(), responses: [
      { status: 200, mediaType: "text/plain", schema: mini.pipe(mini.string(), mini.transform(async (value: string) => value.length)) },
      { status: 400, mediaType: "application/json", schema: mini.object({ message: mini.string() }) },
    ] }]);
    let fail = false;
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => {
      const response = { data: fail ? { message: 1 } : "hello", status: fail ? 400 : 200, statusText: "", headers: new AxiosHeaders({ "content-type": fail ? "application/json" : "text/plain" }), config };
      if (fail) throw new AxiosError("failed", "ERR_BAD_REQUEST", config, undefined, response);
      return response;
    } }) });
    expect(await client.modern()).toBe(5);
    fail = true;
    await expect(client.modern()).rejects.toMatchObject({ cause: { issues: expect.any(Array) } });
  });

  it("builds CRUD contracts from Mini objects", () => {
    const api = makeCrudApi("item", mini.object({ name: mini.string() }));
    const createBody = api[2].parameters[0].schema;
    expect(mini.safeParse(createBody, {}).success).toBe(true);
    expect(mini.safeParse(createBody, { name: 42 }).success).toBe(false);
    expect(mini.safeParse(api[0].response, [{ name: "one" }]).success).toBe(true);
  });

  it("checks synchronous Mini errors and safely rejects async error schemas", () => {
    const api = makeApi([{ method: "get", path: "/x", alias: "x", response: mini.string(), errors: [
      { status: 400, schema: mini.pipe(mini.string(), mini.transform(Number)) },
      { status: 401, schema: mini.pipe(mini.string(), mini.transform(async (value: string) => Number(value))) },
    ] }]);
    const config = { method: "get", url: "/x", headers: new AxiosHeaders() };
    const error = (status: number) => new AxiosError("error", "ERR_BAD_REQUEST", config, undefined, { data: "42", status, statusText: "", headers: {}, config });
    expect(isErrorFromAlias(api, "x", error(400))).toBe(true);
    expect(isErrorFromPath(api, "get", "/x", error(401))).toBe(false);
  });

  it("enforces generated required parameters independently of optional schemas", async () => {
    const api = makeApi([{ method: "get", path: "/required", response: mini.string(), parameters: [
      { name: "q", type: "Query", schema: mini.optional(mini.string()), serialization: { in: "query", name: "q", required: true } },
    ] }]);
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => ({ data: '"ok"', status: 200, statusText: "", headers: new AxiosHeaders({ "content-type": "application/json" }), config }) }) });
    await expect(client.get("/required")).rejects.toBeInstanceOf(OtscError);
    expect(await client.get("/required", { queries: { q: "ok" } })).toBe("ok");
  });
});
