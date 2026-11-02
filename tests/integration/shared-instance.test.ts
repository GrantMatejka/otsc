import axios from "axios";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeApi, Otsc } from "../../src/index.js";

describe("shared Axios instances", () => {
  it("keeps client base URLs isolated without changing instance defaults", async () => {
    const baseUrls: Array<string | undefined> = [];
    const instance = axios.create({
      baseURL: "https://original.test",
      adapter: async (config) => {
        baseUrls.push(config.baseURL);
        return { data: "ok", status: 200, statusText: "OK", headers: {}, config };
      },
    });
    const api = makeApi([{ method: "get", path: "/resource", alias: "resource", response: z.string() }]);
    const first = new Otsc("https://first.test", api, { axiosInstance: instance, validate: false });
    const second = new Otsc("https://second.test", api, { axiosInstance: instance, validate: false });
    await Promise.all([first.resource(), second.resource()]);
    expect(baseUrls).toEqual(["https://first.test", "https://second.test"]);
    expect(instance.defaults.baseURL).toBe("https://original.test");
    expect(first.baseURL).toBe("https://first.test");
    expect(second.baseURL).toBe("https://second.test");
  });
});
