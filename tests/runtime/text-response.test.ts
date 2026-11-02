import { describe, expect, it } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { z } from "zod";
import { makeApi, Otsc, OtscError } from "../../src/runtime/index.js";

describe("JSON text response decoding", () => {
  it("decodes JSON and +json, leaves text intact, and reports invalid JSON", async () => {
    const api = makeApi([{ method: "get", path: "/mixed", alias: "mixed", response: z.unknown(), responses: [
      { status: 200, mediaType: "application/json", schema: z.object({ value: z.number() }) },
      { status: 200, mediaType: "application/problem+json", schema: z.object({ value: z.number() }) },
      { status: 200, mediaType: "text/plain", schema: z.string() },
    ] }] as const);
    let body = '{"value":1}';
    let media = "application/json; charset=utf-8";
    const client = new Otsc(api, { transform: false, axiosInstance: axios.create({ adapter: async config => ({ data: body, status: 200, statusText: "OK", headers: new AxiosHeaders({ "content-type": media }), config }) }) });
    expect(await client.mixed({ responseType: "text" })).toEqual({ value: 1 });
    media = "application/problem+json";
    expect(await client.mixed({ responseType: "text" })).toEqual({ value: 1 });
    media = "text/plain"; body = '{"value":1}';
    expect(await client.mixed({ responseType: "text" })).toBe(body);
    media = "application/json"; body = "{broken";
    await expect(client.mixed({ responseType: "text" })).rejects.toMatchObject({ message: expect.stringContaining("Invalid JSON"), cause: expect.any(SyntaxError) });
  });

  it("decodes and validates error response data while preserving the Axios error", async () => {
    const api = makeApi([{ method: "get", path: "/error", alias: "error", response: z.string(), responses: [
      { status: 400, mediaType: "application/problem+json", schema: z.object({ message: z.string() }) },
    ] }] as const);
    let body = '{"message":"bad"}';
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => {
      const response = { data: body, status: 400, statusText: "Bad Request", headers: new AxiosHeaders({ "content-type": "application/problem+json" }), config };
      throw new AxiosError("bad", "ERR_BAD_REQUEST", config, undefined, response);
    } }) });
    await expect(client.error({ responseType: "text" })).rejects.toMatchObject({ isAxiosError: true, response: { data: { message: "bad" } } });
    body = "not json";
    await expect(client.error({ responseType: "text" })).rejects.toBeInstanceOf(OtscError);
  });

  it("keeps 204 and HEAD bodies undefined even with JSON content type", async () => {
    const api = makeApi([
      { method: "get", path: "/empty", alias: "empty", response: z.void(), responses: [{ status: 204, mediaType: "application/json", schema: z.void() }] },
      { method: "head", path: "/empty", alias: "headEmpty", response: z.void(), responses: [{ status: 200, mediaType: "application/json", schema: z.void() }] },
    ] as const);
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => ({ data: "", status: config.method === "head" ? 200 : 204, statusText: "OK", headers: new AxiosHeaders({ "content-type": "application/json" }), config }) }) });
    expect(await client.empty({ responseType: "text" })).toBeUndefined();
    expect(await client.headEmpty({ responseType: "text" })).toBeUndefined();
  });
});
