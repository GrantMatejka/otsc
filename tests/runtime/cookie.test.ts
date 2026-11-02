import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeApi, Otsc, OtscError } from "../../src/runtime/index.js";

describe("generated cookie parameters", () => {
  it("validates, transforms and serializes cookies through an HTTP request", async () => {
    const api = makeApi([{ method: "get", path: "/cookies", alias: "cookies", parameters: [
      { name: "session", type: "Cookie", schema: z.string().transform(value => value.toUpperCase()), serialization: { in: "cookie", name: "session-id", style: "form", explode: true, required: true } },
      { name: "optional", type: "Cookie", schema: z.string().optional(), serialization: { in: "cookie", name: "optional", style: "form", explode: true } },
    ], response: z.object({ cookie: z.string() }) }] as const);
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? "" }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const client = new Otsc(`http://127.0.0.1:${address.port}`, api);
      expect(await client.cookies({ cookies: { session: "abc123", optional: "x" } })).toEqual({ cookie: "session-id=ABC123; optional=x" });
      await expect(client.cookies({ cookies: { session: 1 as never } })).rejects.toBeInstanceOf(OtscError);
      await expect(client.cookies({ cookies: {} as never })).rejects.toThrow(/Missing required Cookie/);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
