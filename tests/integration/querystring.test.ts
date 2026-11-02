import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeApi, Otsc } from "../../src/index.js";

describe("whole-query serialization", () => {
  it("serializes JSON and form querystrings as the entire query", async () => {
    const targets: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      targets.push(request.url);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify("ok"));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
      const api = makeApi([
        { method: "get", path: "/json", alias: "json", response: z.string(), parameters: [
          { name: "filter", type: "Query", schema: z.object({ numbers: z.array(z.number()), flag: z.boolean() }), serialization: { in: "querystring", name: "filter", mediaType: "application/json", required: true } },
        ] },
        { method: "get", path: "/form", alias: "form", response: z.string(), parameters: [
          { name: "filter", type: "Query", schema: z.object({ color: z.array(z.string()), note: z.string() }), serialization: { in: "querystring", name: "filter", mediaType: "application/x-www-form-urlencoded", required: true } },
        ] },
      ]);
      const client = new Otsc(`http://127.0.0.1:${address.port}`, api);
      expect(await client.json({ queries: { filter: { numbers: [1, 2], flag: true } } })).toBe("ok");
      expect(await client.form({ queries: { filter: { color: ["blue", "black"], note: "a b" } } })).toBe("ok");
      expect(targets).toEqual([
        "/json?%7B%22numbers%22%3A%5B1%2C2%5D%2C%22flag%22%3Atrue%7D",
        "/form?color=blue&color=black&note=a+b",
      ]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
