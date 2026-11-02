import axios, { AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeApi, Otsc } from "../../src/index.js";

describe("OpenAPI security providers", () => {
  it("applies an AND requirement with an asynchronous bearer provider", async () => {
    const api = makeApi([{
      method: "get", path: "/secure", alias: "secure", response: z.string(),
      security: {
        requirements: [{ apiKey: [], accessToken: [] }],
        schemes: {
          apiKey: { type: "apiKey", in: "header", name: "X-API-Key" },
          accessToken: { type: "http", scheme: "bearer" },
        },
      },
    }]);
    let sentHeaders = new AxiosHeaders();
    const instance = axios.create({ adapter: async (config) => {
      sentHeaders = AxiosHeaders.from(config.headers);
      return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
    } });
    const client = new Otsc(api, {
      axiosInstance: instance,
      validate: false,
      credentials: { apiKey: "key", accessToken: async () => "token" },
    });
    expect(await client.secure()).toBe("ok");
    expect(sentHeaders.get("X-API-Key")).toBe("key");
    expect(sentHeaders.get("Authorization")).toBe("Bearer token");
    expect(instance.defaults.headers.common.Authorization).toBeUndefined();
  });

  it("selects a satisfiable alternative and preserves explicitly supplied headers", async () => {
    const api = makeApi([{
      method: "get", path: "/secure", alias: "secure", response: z.string(),
      security: {
        requirements: [{ missing: [] }, { basic: [] }],
        schemes: {
          missing: { type: "http", scheme: "bearer" },
          basic: { type: "http", scheme: "basic" },
        },
      },
    }]);
    const authorizations: unknown[] = [];
    const instance = axios.create({ adapter: async (config) => {
      authorizations.push(config.headers.get("Authorization"));
      return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
    } });
    const client = new Otsc(api, {
      axiosInstance: instance,
      validate: false,
      credentials: { basic: { username: "test", password: "secret" } },
    });
    await client.secure();
    await client.secure({ headers: { Authorization: "Custom value" } });
    expect(authorizations).toEqual(["Basic dGVzdDpzZWNyZXQ=", "Custom value"]);
  });

  it("rejects configured credentials that cannot satisfy any required alternative", async () => {
    const api = makeApi([{
      method: "get", path: "/secure", alias: "secure", response: z.string(),
      security: { requirements: [{ apiKey: [], token: [] }], schemes: {} },
    }]);
    const client = new Otsc(api, { validate: false, credentials: { apiKey: "key" } });
    await expect(client.secure()).rejects.toThrow("No configured credentials satisfy");
  });
});
