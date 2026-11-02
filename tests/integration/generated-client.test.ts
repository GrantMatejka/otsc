import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateClient, writeGeneratedFiles } from "../../src/generator/index.js";

const execute = promisify(execFile);
const specification = {
  openapi: "3.1.0",
  info: { title: "Pets", version: "1.0.0" },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
          { name: "details", in: "query", schema: { type: "boolean" } },
          { name: "tags", in: "query", style: "form", explode: true, schema: { type: "array", items: { type: "string" } } },
        ],
        responses: {
          "200": {
            description: "A pet",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        properties: { id: { type: "string" }, name: { type: "string" } },
        required: ["id", "name"],
      },
    },
  },
};

describe("generated client integration", () => {
  let directory: string;
  let server: Server;
  let baseUrl: string;
  let requestTarget: string | undefined;
  let responseBody = { id: "a/b", name: "Otter" };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(process.cwd(), ".tmp-otsc-"));
    server = createServer((request, response) => {
      requestTarget = request.url;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responseBody));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("generates reproducible files, typechecks them, and validates Axios responses", async () => {
    const first = await generateClient(specification, { outputFile: "client.ts" });
    const second = await generateClient(specification, { outputFile: "client.ts" });
    expect(first.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(first.files).toEqual(second.files);
    expect(first.manifest.outputs).toEqual(second.manifest.outputs);
    await writeGeneratedFiles(first, { outputDir: directory });
    const check = await writeGeneratedFiles(second, { outputDir: directory, check: true });
    expect(check.changed).toEqual([]);

    const consumer = `import { createApiClient } from './client.js';
const client = createApiClient();
client.getPet({ params: { petId: 'abc' }, queries: { details: true, tags: ['blue'] } });
// @ts-expect-error petId must be a string
client.getPet({ params: { petId: 42 } });
`;
    await writeFile(path.join(directory, "consumer.ts"), consumer);
    const compiler = path.join(process.cwd(), "node_modules", ".bin", "tsc");
    await execute(compiler, [
      "--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext",
      "--moduleResolution", "NodeNext", "--target", "ES2022", "--exactOptionalPropertyTypes",
      "--noUncheckedIndexedAccess", path.join(directory, "consumer.ts"),
    ]).catch((error: { stdout?: string; stderr?: string; message: string }) => {
      throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
    });
    const emitted = path.join(directory, "client.mjs");
    await build({ entryPoints: [path.join(directory, "client.ts")], outfile: emitted, platform: "node", format: "esm" });
    const clientModule = await import(pathToFileURL(emitted).href);
    const client = clientModule.createApiClient(baseUrl);
    expect(await client.getPet({ params: { petId: "a/b" }, queries: { details: true, tags: ["a b", "c/d"] } })).toEqual(responseBody);
    expect(requestTarget).toBe("/pets/a%2Fb?details=true&tags=a%20b&tags=c%2Fd");

    responseBody = { id: "a/b", name: 42 as unknown as string };
    await expect(client.getPet({ params: { petId: "a/b" } })).rejects.toThrow();
  });

  it("runs the packaged CLI and detects output drift", async () => {
    const input = path.join(directory, "spec.json");
    const output = path.join(directory, "cli-client.ts");
    const lock = path.join(directory, "openapi.lock.json");
    await writeFile(input, JSON.stringify(specification));
    await execute(process.execPath, ["dist/cli.js", input, "--output", output, "--write-lock", lock]);
    expect(await readFile(output, "utf8")).toContain("createApiClient");
    await execute(process.execPath, ["dist/cli.js", input, "--output", output, "--frozen-lock", lock, "--check"]);
    await writeFile(input, `${JSON.stringify(specification)}\n`);
    await expect(execute(process.execPath, ["dist/cli.js", input, "--output", output, "--frozen-lock", lock]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("LOCK_MISMATCH") });
    await writeFile(input, JSON.stringify(specification));
    await writeFile(output, "stale\n");
    await expect(execute(process.execPath, ["dist/cli.js", input, "--output", output, "--check"]))
      .rejects.toMatchObject({ code: 1 });
  });

  it("matches multiple success statuses and preserves text response bodies", async () => {
    let status = 200;
    const multiServer = createServer((_request, response) => {
      response.statusCode = status;
      if (status === 200) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ value: "ok" }));
      } else if (status === 201) {
        response.setHeader("content-type", "text/plain");
        response.end("42");
      } else response.end();
    });
    await new Promise<void>((resolve, reject) => {
      multiServer.once("error", reject);
      multiServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = multiServer.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
      const spec = {
        openapi: "3.2.1", info: { title: "Multiple", version: "1" },
        paths: { "/result": { get: { operationId: "getResult", responses: {
          "200": { description: "Object", content: { "application/json": { schema: {
            type: "object", properties: { value: { type: "string" } }, required: ["value"],
          } } } },
          "201": { description: "Text", content: { "text/plain": { schema: { type: "string" } } } },
          "204": { description: "Empty" },
        } } } },
      };
      const result = await generateClient(spec, { outputFile: "multi.ts" });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      await writeGeneratedFiles(result, { outputDir: directory });
      await writeFile(path.join(directory, "multi-consumer.ts"), `import { createApiClient } from './multi.js';
async function check() {
  const result = await createApiClient().getResult();
  const valid: { value: string } | string | undefined = result;
  // @ts-expect-error multiple statuses have different response types
  const invalid: string = result;
  return [valid, invalid];
}
void check;
`);
      const compiler = path.join(process.cwd(), "node_modules", ".bin", "tsc");
      await execute(compiler, ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(directory, "multi-consumer.ts")])
        .catch((error: { stdout?: string; stderr?: string; message: string }) => {
          throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
        });
      const emitted = path.join(directory, "multi.mjs");
      await build({ entryPoints: [path.join(directory, "multi.ts")], outfile: emitted, platform: "node", format: "esm" });
      const clientModule = await import(pathToFileURL(emitted).href);
      const client = clientModule.createApiClient(`http://127.0.0.1:${address.port}`);
      expect(await client.getResult()).toEqual({ value: "ok" });
      status = 201;
      expect(await client.getResult()).toBe("42");
      status = 204;
      expect(await client.getResult()).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => multiServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("generates security requirements and applies credential providers", async () => {
    let receivedTarget: string | undefined;
    let authorization: string | undefined;
    const securedServer = createServer((request, response) => {
      receivedTarget = request.url;
      authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve, reject) => {
      securedServer.once("error", reject);
      securedServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = securedServer.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
      const spec = {
        openapi: "3.1.0", info: { title: "Secured", version: "1" },
        security: [{ apiKey: [], token: [] }],
        components: { securitySchemes: {
          apiKey: { type: "apiKey", in: "query", name: "api_key" },
          token: { type: "http", scheme: "bearer" },
        } },
        paths: { "/secure": { get: { operationId: "getSecure", responses: {
          "200": { description: "OK", content: { "application/json": { schema: {
            type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"],
          } } } },
        } } } },
      };
      const result = await generateClient(spec, { outputFile: "secure.ts" });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      await writeGeneratedFiles(result, { outputDir: directory });
      const emitted = path.join(directory, "secure.mjs");
      await build({ entryPoints: [path.join(directory, "secure.ts")], outfile: emitted, platform: "node", format: "esm" });
      const clientModule = await import(pathToFileURL(emitted).href);
      const client = clientModule.createApiClient(`http://127.0.0.1:${address.port}`, {
        credentials: { apiKey: "key", token: async () => "token" },
      });
      expect(await client.getSecure()).toEqual({ ok: true });
      expect(receivedTarget).toBe("/secure?api_key=key");
      expect(authorization).toBe("Bearer token");
    } finally {
      await new Promise<void>((resolve, reject) => securedServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("projects read-only and write-only required fields by direction", async () => {
    let receivedBody = "";
    const projectionServer = createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { receivedBody += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ id: "user-1" }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      projectionServer.once("error", reject);
      projectionServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = projectionServer.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
      const spec = {
        openapi: "3.1.0", info: { title: "Projection", version: "1" },
        components: { schemas: { User: {
          type: "object", properties: {
            id: { type: "string", readOnly: true },
            password: { type: "string", writeOnly: true },
          }, required: ["id", "password"],
        } } },
        paths: { "/users": { post: {
          operationId: "createUser",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } },
          responses: { "200": { description: "User", content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } } } },
        } } },
      };
      const result = await generateClient(spec, { outputFile: "projection.ts" });
      expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
      await writeGeneratedFiles(result, { outputDir: directory });
      await writeFile(path.join(directory, "projection-consumer.ts"), `import { createApiClient } from './projection.js';
async function check() {
  const user = await createApiClient().createUser({ password: 'secret' });
  const id: string = user.id;
  const password: string | undefined = user.password;
  return [id, password];
}
void check;
`);
      const compiler = path.join(process.cwd(), "node_modules", ".bin", "tsc");
      await execute(compiler, ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(directory, "projection-consumer.ts")])
        .catch((error: { stdout?: string; stderr?: string; message: string }) => {
          throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
        });
      const emitted = path.join(directory, "projection.mjs");
      await build({ entryPoints: [path.join(directory, "projection.ts")], outfile: emitted, platform: "node", format: "esm" });
      const clientModule = await import(pathToFileURL(emitted).href);
      const client = clientModule.createApiClient(`http://127.0.0.1:${address.port}`);
      expect(await client.createUser({ password: "secret" })).toEqual({ id: "user-1" });
      expect(JSON.parse(receivedBody)).toEqual({ password: "secret" });
    } finally {
      await new Promise<void>((resolve, reject) => projectionServer.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("emits executable standalone validators for evaluation-dependent schemas", async () => {
    const spec = {
      openapi: "3.1.0", info: { title: "Unevaluated", version: "1" }, paths: {},
      components: { schemas: { Entity: {
        type: "object", properties: { id: { type: "string" } }, required: ["id"], unevaluatedProperties: false,
      } } },
    };
    const result = await generateClient(spec, { outputFile: "evaluated.ts", schemaOnly: true });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.files.some((file) => file.path.endsWith(".mjs"))).toBe(true);
    expect(result.files.some((file) => file.path.endsWith(".d.mts"))).toBe(true);
    await writeGeneratedFiles(result, { outputDir: directory });
    const compiler = path.join(process.cwd(), "node_modules", ".bin", "tsc");
    await execute(compiler, ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(directory, "evaluated.ts")])
      .catch((error: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
      });
    const emitted = path.join(directory, "evaluated.mjs");
    await build({ entryPoints: [path.join(directory, "evaluated.ts")], outfile: emitted, platform: "node", format: "esm" });
    const clientModule = await import(pathToFileURL(emitted).href);
    expect(clientModule.Entity.parse({ id: "ok" })).toEqual({ id: "ok" });
    expect(() => clientModule.Entity.parse({ id: "ok", extra: true })).toThrow();
  });
});
