import { describe, expect, it } from "vitest";
import axios, { AxiosHeaders } from "axios";
import { z } from "zod";
import { makeApi, Otsc, OtscError } from "../../src/runtime/index.js";

describe("empty HTTP responses", () => {
  it("normalizes and validates empty 204, 205 and HEAD responses", async () => {
    const api = makeApi([
      { method: "delete", path: "/legacy", alias: "legacy", response: z.void(), status: 204 },
      { method: "post", path: "/modern", alias: "modern", response: z.void(), responses: [{ status: 205, schema: z.void() }] },
      { method: "head", path: "/head", alias: "headEndpoint", response: z.void() },
    ] as const);
    const client = new Otsc(api, { transform: false, axiosInstance: axios.create({ adapter: async config => ({
      data: "", status: config.url === "/legacy" ? 204 : config.url === "/modern" ? 205 : 200,
      statusText: "", headers: new AxiosHeaders(), config,
    }) }) });
    expect(await client.legacy(undefined)).toBeUndefined();
    expect(await client.modern(undefined)).toBeUndefined();
    expect(await client.headEndpoint()).toBeUndefined();
  });

  it("validates normalized data and preserves ordinary empty responses", async () => {
    const api = makeApi([
      { method: "get", path: "/invalid", alias: "invalid", response: z.string(), status: 204 },
      { method: "get", path: "/text", alias: "text", response: z.string() },
    ] as const);
    const client = new Otsc(api, { axiosInstance: axios.create({ adapter: async config => ({
      data: "", status: config.url === "/invalid" ? 204 : 200,
      statusText: "", headers: new AxiosHeaders(), config,
    }) }) });
    await expect(client.invalid()).rejects.toBeInstanceOf(OtscError);
    expect(await client.text()).toBe("");
  });
});
