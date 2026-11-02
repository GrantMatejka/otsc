import { describe, expect, it } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { z } from "zod";
import { Otsc, OtscError, apiBuilder, makeApi, makeCrudApi, mergeApis, parametersBuilder, isErrorFromAlias } from "../../src/runtime/index.js";

describe("Otsc Zod 4 runtime", () => {
  it("validates async transforms, defaults and axios options", async () => {
    const api = makeApi([{ method: "get", path: "/items/:id", alias: "item", parameters: [
      { name: "id", type: "Path", schema: z.string().transform(async value => value.toUpperCase()) },
      { name: "limit", type: "Query", schema: z.number().default(3) },
    ], response: z.object({ value: z.string().transform(async value => value.length) }) }] as const);
    let sent: any;
    const instance = axios.create({ adapter: async config => {
      sent = config;
      return { data: { value: "hello" }, status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config };
    } });
    const client = new Otsc("https://example.test", api, { axiosInstance: instance, sendDefaults: true });
    expect(await client.item({ params: { id: "abc" }, timeout: 123 })).toEqual({ value: 5 });
    expect(sent.url).toBe("/items/ABC");
    expect(sent.params).toEqual({ limit: 3 });
    expect(sent.timeout).toBe(123);
    expect(client.axios).toBe(instance);
    expect(client.baseURL).toBe("https://example.test");
  });

  it("preserves plugin order, replacement and endpoint ejection", async () => {
    const api = makeApi([{ method: "get", path: "/x", alias: "x", response: z.string() }] as const);
    const events: string[] = [];
    const client = new Otsc(api, { validate: false, axiosInstance: axios.create({ adapter: async config => ({ data: "ok", status: 200, statusText: "OK", headers: {}, config }) }) });
    const plugin = (name: string) => ({ name, request: async (_: any, config: any) => { events.push(`${name}:request`); return config; }, response: async (_: any, __: any, res: any) => { events.push(`${name}:response`); return res; } });
    client.use(plugin("global"));
    const id = client.use("x", plugin("endpoint"));
    client.use("x", { ...plugin("replacement"), name: "endpoint" });
    expect(await client.x()).toBe("ok");
    expect(events).toEqual(["global:request", "replacement:request", "replacement:response", "global:response"]);
    client.eject(id); events.length = 0;
    await client.get("/x");
    expect(events).toEqual(["global:request", "global:response"]);
  });

  it("reports invalid responses and matches declared errors by status", async () => {
    const api = makeApi([{ method: "get", path: "/x", alias: "x", response: z.number(), errors: [{ status: 404, schema: z.object({ message: z.string() }) }] }] as const);
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => ({ data: "bad", status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config }) }) });
    await expect(client.x()).rejects.toBeInstanceOf(OtscError);
    const config = { method: "get", url: "/x", headers: new AxiosHeaders() };
    const error = new AxiosError("missing", "ERR_BAD_REQUEST", config, undefined, { data: { message: "missing" }, status: 404, statusText: "Not Found", headers: {}, config });
    expect(isErrorFromAlias(api, "x", error)).toBe(true);
  });

  it("builds and combines APIs and rejects duplicate endpoints", () => {
    const params = parametersBuilder().addQuery("page", z.number()).build();
    const api = apiBuilder().addEndpoint({ method: "get", path: "/", response: z.string(), parameters: params }).build();
    expect(mergeApis({ "/v1": api })[0].path).toBe("/v1");
    expect(makeCrudApi("user", z.object({ id: z.number() }))).toHaveLength(6);
    expect(() => makeApi([{ method: "get", path: "/x", response: z.string() }, { method: "get", path: "/x", response: z.string() }])).toThrow(/Duplicate path/);
  });

  it("honors disabled transformations and uses codec input/output directions", async () => {
    const codec = z.codec(z.string(), z.number(), { decode: Number, encode: String });
    const api = makeApi([{ method: "post", path: "/codec", alias: "codec", parameters: [{ name: "body", type: "Body", schema: codec }], response: codec }] as const);
    const sent: unknown[] = [];
    const instance = axios.create({ adapter: async config => {
      sent.push(config.data);
      return { data: '"42"', status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config };
    } });
    const transformed = new Otsc(api, { axiosInstance: instance });
    expect(await transformed.codec("7")).toBe(42);
    const raw = new Otsc(api, { axiosInstance: instance, transform: false });
    expect(await raw.codec("7")).toBe("42");
    expect(sent).toEqual([7, "7"]);
  });

  it("serializes form-url bodies and supports OPTIONS and extension requests", async () => {
    const api = makeApi([
      { method: "post", path: "/form", alias: "form", requestFormat: "form-url", parameters: [{ name: "body", type: "Body", schema: z.object({ name: z.string() }) }], response: z.string() },
      { method: "options", path: "/form", alias: "optionsForm", response: z.string() },
      { method: "custom", path: "/custom", alias: "custom", response: z.string() },
    ] as const);
    const sent: Array<{ method?: string; data?: unknown }> = [];
    const client = new Otsc(api, { validate: false, axiosInstance: axios.create({ adapter: async config => {
      sent.push({ method: config.method, data: config.data });
      return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
    } }) });
    await client.form({ name: "a b" });
    await client.optionsForm();
    await client.request({ method: "custom", url: "/custom" });
    expect(sent).toEqual([{ method: "post", data: "name=a+b" }, { method: "options", data: undefined }, { method: "custom", data: undefined }]);
  });


  it("dispatches response schemas by status and media type, including Axios errors", async () => {
    const api = makeApi([{ method: "get", path: "/response", alias: "response", response: z.never(), responses: [
      { status: "2XX", mediaType: "application/json", schema: z.object({ value: z.string() }) },
      { status: 201, mediaType: "text/plain", schema: z.string().transform(value => value.toUpperCase()) },
      { status: 404, mediaType: "application/json", schema: z.object({ message: z.string() }) },
      { status: "default", schema: z.number() },
    ] }] as const);
    let status = 201;
    const instance = axios.create({ adapter: async config => {
      const response = { data: status === 201 ? "created" : status === 404 ? { message: "missing" } : 4, status, statusText: "", headers: new AxiosHeaders({ "content-type": status === 201 ? "text/plain; charset=utf-8" : "application/json" }), config };
      if (status >= 400) throw new AxiosError("failed", "ERR_BAD_RESPONSE", config, undefined, response);
      return response;
    } });
    const client = new Otsc(api, { axiosInstance: instance });
    expect(await client.response()).toBe("CREATED");
    status = 404;
    await expect(client.response()).rejects.toBeInstanceOf(AxiosError);
    status = 500;
    await expect(client.response()).rejects.toBeInstanceOf(AxiosError);
    status = 202;
    await expect(client.response()).rejects.toBeInstanceOf(OtscError);
  });

});
