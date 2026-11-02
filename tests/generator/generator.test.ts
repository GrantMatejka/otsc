import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import axios from "axios";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import {
  generateClient,
  writeGeneratedFiles,
} from "../../src/generator/index.js";

const document = {
  openapi: "3.1.0",
  info: { title: "Example", version: "1" },
  components: {
    schemas: {
      Node: {
        type: "object",
        required: ["value"],
        properties: {
          value: { type: "string" },
          next: { $ref: "#/components/schemas/Node" },
        },
      },
      class: { type: "number" },
    },
  },
  paths: {
    "/nodes/{id}": {
      get: {
        operationId: "getNode",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Node" },
              },
            },
          },
          "404": {
            content: { "application/json": { schema: { type: "string" } } },
          },
        },
      },
    },
  },
};

describe("generateClient", () => {
  it("generates recursive references, parameters, errors and deterministic manifests", async () => {
    const result = await generateClient(document);
    expect(result.diagnostics).toEqual([]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0].content).toContain(
      "const NodeReference: z.ZodType<any> = z.lazy(() => Node)",
    );
    expect(result.files[0].content).toContain("export const class_");
    expect(result.files[0].content).toContain('type: "Path"');
    expect(result.files[0].content).toContain("status: 404");
    expect(result.contracts.operations[0]).toMatchObject({
      alias: "getNode",
      path: "/nodes/{id}",
      responses: ["200", "404"],
    });
    expect(await generateClient(document)).toEqual(result);
  });

  it("loads YAML and external schemas and reports missing references", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "otsc-generator-"));
    try {
      await writeFile(
        path.join(directory, "spec.yaml"),
        "openapi: 3.1.0\ncomponents:\n  schemas:\n    Cat:\n      $ref: ./cat.yaml#/Cat\npaths: {}\n",
      );
      await writeFile(
        path.join(directory, "cat.yaml"),
        "Cat:\n  type: string\n",
      );
      const result = await generateClient(path.join(directory, "spec.yaml"));
      expect(result.diagnostics).toEqual([]);
      expect(result.manifest.inputs.map((input) => input.uri)).toEqual([
        "cat.yaml",
        "root",
      ]);
      expect(result.files[0].content).toContain("z.string()");
      await rm(path.join(directory, "cat.yaml"));
      const broken = await generateClient(path.join(directory, "spec.yaml"));
      expect(broken.files).toEqual([]);
      expect(
        broken.diagnostics.some(
          (diagnostic) => diagnostic.code === "REFERENCE_ERROR",
        ),
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("diagnoses unsupported schemas and ambiguous aliases without emitting misleading code", async () => {
    const invalid = {
      openapi: "3.1.0",
      components: { schemas: { Bad: { type: "string", contentSchema: {} } } },
      paths: {
        "/a": { get: { operationId: "same", responses: {} } },
        "/b": { get: { operationId: "same", responses: {} } },
      },
    };
    const result = await generateClient(invalid);
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "SCHEMA_COMPILE_ERROR",
    );
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "DUPLICATE_ALIAS",
    );
  });

  it("supports Swagger 2 definitions, request body and server", async () => {
    const result = await generateClient({
      swagger: "2.0",
      host: "example.test",
      basePath: "/v1",
      definitions: { Payload: { type: "string" } },
      paths: {
        "/echo": {
          post: {
            parameters: [
              {
                name: "data",
                in: "body",
                required: true,
                schema: { $ref: "#/definitions/Payload" },
              },
            ],
            responses: { "200": { schema: { type: "string" } } },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files[0].content).toContain("https://example.test/v1");
    expect(result.files[0].content).toContain('type: "Body"');
  });

  it("retains each response status and media and sets request formats", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      paths: {
        "/pets": {
          post: {
            operationId: "uploadPet",
            requestBody: {
              required: true,
              content: {
                "multipart/form-data": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": { schema: { type: "string" } },
                  "text/plain": { schema: { type: "number" } },
                },
              },
              "2XX": {
                content: {
                  "application/json": { schema: { type: "boolean" } },
                },
              },
              "404": {
                content: { "text/plain": { schema: { type: "string" } } },
              },
              default: { description: "Other" },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const source = result.files[0].content;
    expect(source).toContain('path: "/pets", originalPath: "/pets"');
    expect(source).toContain('requestFormat: "form-data"');
    expect(source).toContain('status: 200, mediaType: "application/json"');
    expect(source).toContain('status: 200, mediaType: "text/plain"');
    expect(source).toContain('status: "2XX", mediaType: "application/json"');
    expect(source).toContain('status: 404, mediaType: "text/plain"');
    expect(source).toContain('status: "default", schema: z.undefined()');
  });

  it("preserves wire serialization metadata for parameters", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      paths: {
        "/pets/{pet_id}": {
          get: {
            operationId: "findPet",
            parameters: [
              {
                name: "pet_id",
                in: "path",
                required: true,
                style: "label",
                explode: false,
                schema: { type: "string" },
              },
              {
                name: "filter[]",
                in: "query",
                style: "form",
                explode: true,
                allowReserved: true,
                schema: { type: "string" },
              },
              {
                name: "X-Token",
                in: "header",
                required: true,
                schema: { type: "string" },
              },
              { name: "session", in: "cookie", schema: { type: "string" } },
            ],
            responses: { "204": { description: "empty" } },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const source = result.files[0].content;
    expect(source).toContain(
      'serialization: {"in":"path","name":"pet_id","style":"label","explode":false,"required":true}',
    );
    expect(source).toContain(
      'serialization: {"in":"query","name":"filter[]","style":"form","explode":true,"allowReserved":true}',
    );
    expect(source).toContain(
      'serialization: {"in":"header","name":"X-Token","required":true}',
    );
    expect(source).toContain('name: "session", type: "Cookie"');
    expect(source).toContain('serialization: {"in":"cookie","name":"session"}');
  });

  it("diagnoses content parameters that cannot be serialized", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      paths: {
        "/": {
          get: {
            parameters: [
              {
                name: "filter",
                in: "query",
                content: { "application/json": { schema: { type: "string" } } },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(result.files).toEqual([]);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_PARAMETER",
      ),
    ).toBe(true);
  });

  it("includes OpenAPI 3.2 additional operations and diagnoses case and token restrictions", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/resource": {
          query: {
            operationId: "searchResource",
            responses: { "200": { description: "ok" } },
          },
          additionalOperations: {
            PURGE: {
              operationId: "purgeResource",
              responses: { "204": { description: "ok" } },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(
      result.contracts.operations.map((operation) => operation.method),
    ).toEqual(["query", "PURGE"]);
    expect(result.files[0].content).toContain('method: "PURGE"');
    const invalid = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/": {
          additionalOperations: {
            MiXeD: { responses: {} },
            "bad method": { responses: {} },
            GET: { responses: {} },
          },
        },
      },
    });
    expect(invalid.files).toEqual([]);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_METHOD_CASE",
        "INVALID_METHOD",
        "INVALID_ADDITIONAL_OPERATION",
      ]),
    );
  });

  it("emits whole-query content metadata and rejects conflicting query parameters", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "criteria",
                in: "querystring",
                required: true,
                content: {
                  "application/x-www-form-urlencoded": {
                    schema: { type: "string" },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files[0].content).toContain(
      'serialization: {"in":"querystring","name":"criteria","mediaType":"application/x-www-form-urlencoded","required":true}',
    );
    expect(result.contracts.operations[0].querystring).toEqual([
      {
        name: "criteria",
        required: true,
        media: [
          {
            mediaType: "application/x-www-form-urlencoded",
            schema: "z.string()",
          },
        ],
      },
    ]);
    const conflict = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/": {
          get: {
            parameters: [
              {
                name: "whole",
                in: "querystring",
                content: { "text/plain": { schema: { type: "string" } } },
              },
              { name: "part", in: "query", schema: { type: "string" } },
            ],
            responses: {},
          },
        },
      },
    });
    expect(conflict.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "INVALID_QUERYSTRING",
    );
  });

  it("emits each supported querystring media and diagnoses unsupported encoding", async () => {
    for (const mediaType of [
      "application/json",
      "application/x-www-form-urlencoded",
      "text/plain",
      "application/jsonpath",
    ]) {
      const result = await generateClient({
        openapi: "3.2.0",
        paths: {
          "/search": {
            get: {
              operationId: "search",
              parameters: [
                {
                  name: "query",
                  in: "querystring",
                  content: { [mediaType]: { schema: { type: "string" } } },
                },
              ],
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.files[0].content).toContain(
        `"in":"querystring","name":"query","mediaType":"${mediaType}","required":false`,
      );
    }
    const invalid = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/search": {
          get: {
            parameters: [
              {
                name: "query",
                in: "querystring",
                content: {
                  "application/xml": {
                    schema: { type: "string" },
                    encoding: { field: {} },
                  },
                },
              },
            ],
            responses: {},
          },
        },
      },
    });
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_MEDIA_FEATURE",
        "UNSUPPORTED_QUERYSTRING_MEDIA",
      ]),
    );
  });

  it("executes a typed whole-query JSON parameter", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/search": {
          get: {
            operationId: "search",
            parameters: [
              {
                name: "criteria",
                in: "querystring",
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { term: { type: "string" } },
                      required: ["term"],
                    },
                  },
                },
              },
            ],
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      await writeFile(
        path.join(directory, "client.ts"),
        result.files[0].content,
      );
      await writeFile(
        path.join(directory, "consumer.ts"),
        `import { createApiClient } from './client.js';
createApiClient().search({ queries: { criteria: { term: 'cat' } } });
// @ts-expect-error term must be a string
createApiClient().search({ queries: { criteria: { term: 42 } } });
`,
      );
      try {
        execFileSync(path.join(process.cwd(), "node_modules/.bin/tsc"), [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          path.join(directory, "consumer.ts"),
        ]);
      } catch (cause) {
        throw new Error(String((cause as { stdout: Buffer }).stdout));
      }
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const client = generated.createApiClient("https://example.test");
      let requestUrl = "";
      client.axios.defaults.adapter = async (config: any) => {
        requestUrl = client.axios.getUri(config);
        return {
          status: 200,
          statusText: "OK",
          data: "ok",
          headers: { "content-type": "application/json" },
          config,
        };
      };
      expect(
        await client.search({ queries: { criteria: { term: "cat" } } }),
      ).toBe("ok");
      expect(requestUrl).toBe(
        "https://example.test/search?%7B%22term%22%3A%22cat%22%7D",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unresolved and runtime-incompatible path templates", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/pets/{pet-id}.json": {
          get: {
            parameters: [
              {
                name: "pet-id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {},
          },
        },
        "/missing/{id}": { get: { responses: {} } },
        "/orphan": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {},
          },
        },
        "/mixed/{id}.json": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {},
          },
        },
      },
    });
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(
      codes.filter((code) => code === "UNSUPPORTED_PATH_TEMPLATE"),
    ).toHaveLength(2);
    expect(codes).toContain("MISSING_PATH_PARAMETER");
    expect(codes).toContain("MISSING_PATH_TEMPLATE");
    expect(result.files).toEqual([]);
  });

  it("types and serializes hyphenated path names in mixed-prefix segments", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/pets/v{pet-id}": {
          get: {
            operationId: "findPet",
            parameters: [
              {
                name: "pet-id",
                in: "path",
                required: true,
                schema: { type: "string" },
              },
            ],
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      await writeFile(
        path.join(directory, "client.ts"),
        result.files[0].content,
      );
      await writeFile(
        path.join(directory, "consumer.ts"),
        `import { createApiClient } from './client.js';
createApiClient().findPet({ params: { 'pet-id': 'abc' } });
// @ts-expect-error the original wire name must be used
createApiClient().findPet({ params: { pet: 'abc' } });
`,
      );
      try {
        execFileSync(path.join(process.cwd(), "node_modules/.bin/tsc"), [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          path.join(directory, "consumer.ts"),
        ]);
      } catch (cause) {
        throw new Error(String((cause as { stdout: Buffer }).stdout));
      }
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const client = generated.createApiClient("https://example.test");
      let requestUrl = "";
      client.axios.defaults.adapter = async (config: { url?: string }) => {
        requestUrl = config.url ?? "";
        return {
          status: 200,
          data: "ok",
          headers: { "content-type": "application/json" },
          config,
        };
      };
      expect(await client.findPet({ params: { "pet-id": "a/b" } })).toBe("ok");
      expect(requestUrl).toBe("/pets/va%2Fb");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("emits inherited, overridden, and anonymous security requirements", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      components: {
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
          Bearer: { type: "http", scheme: "bearer" },
          OAuth: { type: "oauth2", flows: {} },
          Linked: { $ref: "#/components/securitySchemes/Bearer" },
        },
      },
      security: [{ ApiKey: [], OAuth: ["read"] }, {}],
      paths: {
        "/inherited": {
          get: {
            operationId: "inherited",
            responses: { "200": { description: "ok" } },
          },
        },
        "/override": {
          get: {
            operationId: "override",
            security: [{ Linked: [] }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/public": {
          get: {
            operationId: "publicEndpoint",
            security: [],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const inherited = generated.endpoints.find(
        (endpoint: { alias: string }) => endpoint.alias === "inherited",
      );
      const override = generated.endpoints.find(
        (endpoint: { alias: string }) => endpoint.alias === "override",
      );
      const publicEndpoint = generated.endpoints.find(
        (endpoint: { alias: string }) => endpoint.alias === "publicEndpoint",
      );
      expect(inherited.security).toEqual({
        requirements: [{ ApiKey: [], OAuth: ["read"] }, {}],
        schemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
          OAuth: { type: "oauth2" },
        },
      });
      expect(override.security).toEqual({
        requirements: [{ Linked: [] }],
        schemes: { Linked: { type: "http", scheme: "bearer" } },
      });
      expect(publicEndpoint.security).toEqual({
        requirements: [],
        schemes: {},
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forwards credentials and a supplied Axios instance to a generated client", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      components: {
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
        },
      },
      security: [{ ApiKey: [] }],
      paths: {
        "/private": {
          get: {
            operationId: "getPrivate",
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "string" } } },
              },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files[0].content).toContain(
      "import { makeApi, Otsc, type OtscOptions } from 'otsc'",
    );
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const instance = axios.create();
      let receivedKey: unknown;
      instance.defaults.adapter = async (config) => {
        receivedKey = config.headers.get("X-Api-Key");
        return {
          status: 200,
          statusText: "OK",
          data: "secured",
          headers: { "content-type": "application/json" },
          config,
        };
      };
      const client = generated.createApiClient("https://example.test", {
        axiosInstance: instance,
        credentials: { ApiKey: "secret" },
      });
      expect(client.axios).toBe(instance);
      expect(await client.getPrivate()).toBe("secured");
      expect(receivedKey).toBe("secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes Swagger security and reports unknown or unsupported schemes", async () => {
    const swagger = await generateClient({
      swagger: "2.0",
      securityDefinitions: {
        basicAuth: { type: "basic" },
        queryKey: { type: "apiKey", in: "query", name: "api_key" },
      },
      security: [{ basicAuth: [], queryKey: [] }],
      paths: { "/": { get: { responses: { "200": { description: "ok" } } } } },
    });
    expect(swagger.diagnostics).toEqual([]);
    expect(swagger.files[0].content).toContain(
      '["basicAuth"]: { ["scheme"]: "basic", ["type"]: "http" }',
    );
    expect(swagger.files[0].content).toContain(
      '["queryKey"]: { ["in"]: "query", ["name"]: "api_key", ["type"]: "apiKey" }',
    );
    const invalid = await generateClient({
      openapi: "3.1.0",
      components: {
        securitySchemes: { Digest: { type: "http", scheme: "digest" } },
      },
      security: [{ Missing: [], Digest: [] }],
      paths: { "/": { get: { responses: {} } } },
    });
    expect(invalid.files).toEqual([]);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "UNKNOWN_SECURITY_SCHEME",
        "UNSUPPORTED_SECURITY_SCHEME",
      ]),
    );
    expect(
      invalid.diagnostics.find(
        (diagnostic) => diagnostic.code === "UNSUPPORTED_SECURITY_SCHEME",
      )?.location?.pointer,
    ).toBe("/components/securitySchemes/Digest");
  });

  it("projects request and response schemas through shared references", async () => {
    const specification = {
      openapi: "3.1.0",
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "string", readOnly: true },
              password: { type: "string", writeOnly: true },
              name: { type: "string" },
            },
            required: ["id", "password", "name"],
          },
        },
      },
      paths: {
        "/users": {
          post: {
            operationId: "createUser",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/User" },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = await generateClient(specification);
    expect(result.diagnostics).toEqual([]);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      await writeFile(
        path.join(directory, "client.ts"),
        result.files[0].content,
      );
      await writeFile(
        path.join(directory, "consumer.ts"),
        `import { createApiClient } from './client.js';
const client = createApiClient();
client.createUser({ name: 'Alice', password: 'secret' }).then(user => { const id: string = user.id; void id; });
// @ts-expect-error request password remains required
client.createUser({ name: 'Alice' });
`,
      );
      try {
        execFileSync(path.join(process.cwd(), "node_modules/.bin/tsc"), [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          path.join(directory, "consumer.ts"),
        ]);
      } catch (cause) {
        throw new Error(String((cause as { stdout: Buffer }).stdout));
      }
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const client = generated.createApiClient("https://example.test");
      let response = { name: "Alice", id: "42" };
      client.axios.defaults.adapter = async (config: object) => ({
        status: 200,
        statusText: "OK",
        data: response,
        headers: { "content-type": "application/json" },
        config,
      });
      expect(
        await client.createUser({ name: "Alice", password: "secret" }),
      ).toEqual(response);
      await expect(client.createUser({ name: "Alice" })).rejects.toThrow();
      response = { name: "Alice" } as typeof response;
      await expect(
        client.createUser({ name: "Alice", password: "secret" }),
      ).rejects.toThrow();
      expect(generated.User.safeParse({ name: "Alice" }).success).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("projects recursive references without sharing request and response validators", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      components: {
        schemas: {
          Node: {
            type: "object",
            properties: {
              id: { type: "string", readOnly: true },
              secret: { type: "string", writeOnly: true },
              child: { $ref: "#/components/schemas/Node" },
            },
            required: ["id", "secret"],
          },
        },
      },
      paths: {
        "/nodes": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Node" },
                },
              },
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/Node" },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const endpoint = generated.endpoints[0];
      expect(
        endpoint.parameters[0].schema.safeParse({
          secret: "s",
          child: { secret: "s2" },
        }).success,
      ).toBe(true);
      expect(
        endpoint.parameters[0].schema.safeParse({
          secret: "s",
          child: { id: "1" },
        }).success,
      ).toBe(false);
      expect(
        endpoint.response.safeParse({ id: "1", child: { id: "2" } }).success,
      ).toBe(true);
      expect(
        endpoint.response.safeParse({ id: "1", child: { secret: "s" } })
          .success,
      ).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("diagnoses incompatible projection contexts", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      components: {
        schemas: {
          Shared: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
      paths: {
        "/": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    allOf: [
                      { $ref: "#/components/schemas/Shared" },
                      {
                        type: "object",
                        properties: { id: { type: "string", readOnly: true } },
                      },
                    ],
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
        "/other": {
          post: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Shared" },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "SCHEMA_PROJECTION_ERROR",
    );
    expect(result.files).toEqual([]);
  });

  it("reports unsupported streaming, encoding and server overrides at their locations", async () => {
    const result = await generateClient({
      openapi: "3.2.0",
      paths: {
        "/stream": {
          get: {
            servers: [{ url: "https://other.test" }],
            responses: {
              "200": {
                content: {
                  "application/jsonl": { itemSchema: { type: "string" } },
                },
              },
            },
          },
          post: {
            requestBody: {
              content: {
                "multipart/form-data": {
                  schema: { type: "object" },
                  prefixEncoding: [{}],
                },
              },
            },
            responses: { "204": { description: "empty" } },
          },
        },
      },
    });
    expect(result.files).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "UNSUPPORTED_MEDIA_FEATURE",
        "UNSUPPORTED_SERVER_OVERRIDE",
      ]),
    );
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.location?.pointer),
    ).toContain(
      "/paths/~1stream/get/responses/200/content/application~1jsonl/itemSchema",
    );
    expect(
      result.diagnostics.map((diagnostic) => diagnostic.location?.pointer),
    ).toContain(
      "/paths/~1stream/post/requestBody/content/multipart~1form-data/prefixEncoding",
    );
  });

  it("returns a typed union and dispatches 200, 201, 204 and default contracts", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      paths: {
        "/status": {
          get: {
            operationId: "getStatus",
            responses: {
              "200": {
                content: { "application/json": { schema: { type: "string" } } },
              },
              "201": {
                content: { "application/json": { schema: { type: "number" } } },
              },
              "204": { description: "empty" },
              default: {
                content: {
                  "application/json": { schema: { type: "boolean" } },
                },
              },
            },
          },
        },
      },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.files[0].content).toContain(
      "response: z.union([z.string(), z.number(), z.undefined(), z.boolean()])",
    );
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      await writeFile(
        path.join(directory, "client.ts"),
        result.files[0].content,
      );
      await writeFile(
        path.join(directory, "consumer.ts"),
        `import { createApiClient } from './client.js';
const response: Promise<string | number | undefined | boolean> = createApiClient().getStatus();
// @ts-expect-error The result also includes number, void, and boolean.
const narrow: Promise<string> = createApiClient().getStatus();
void response; void narrow;
`,
      );
      try {
        execFileSync(path.join(process.cwd(), "node_modules/.bin/tsc"), [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          path.join(directory, "consumer.ts"),
        ]);
      } catch (cause) {
        throw new Error(String((cause as { stdout: Buffer }).stdout));
      }
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const client = generated.createApiClient("https://example.test");
      for (const [status, data] of [
        [200, "ok"],
        [201, 42],
        [204, undefined],
        [202, true],
      ] as const) {
        client.axios.defaults.adapter = async (config: object) => ({
          status,
          statusText: "OK",
          data,
          headers: status === 204 ? {} : { "content-type": "application/json" },
          config,
        });
        expect(await client.getStatus()).toEqual(data);
      }
      client.axios.defaults.adapter = async (config: object) => ({
        status: 201,
        statusText: "OK",
        data: "not a number",
        headers: { "content-type": "application/json" },
        config,
      });
      await expect(client.getStatus()).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("executes generated recursive schemas with forward references", async () => {
    const result = await generateClient(document, { schemaOnly: true });
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      const javascript = await transform(result.files[0].content, {
        loader: "ts",
        format: "esm",
      });
      const modulePath = path.join(directory, "generated.mjs");
      await writeFile(modulePath, javascript.code);
      const generated = await import(pathToFileURL(modulePath).href);
      expect(
        generated.Node.parse({ value: "root", next: { value: "child" } }),
      ).toEqual({ value: "root", next: { value: "child" } });
      expect(generated.Node.safeParse({ value: 7 }).success).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("generates a client that calls an endpoint with path parameters", async () => {
    const result = await generateClient(document);
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      const bundle = await build({
        stdin: {
          contents: result.files[0].content,
          loader: "ts",
          resolveDir: process.cwd(),
        },
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        alias: { otsc: path.resolve("src/index.ts") },
        external: ["zod", "axios"],
      });
      const modulePath = path.join(directory, "client.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      const client = generated.createApiClient("https://example.test");
      let requestUrl = "";
      client.axios.defaults.adapter = async (config: { url?: string }) => {
        requestUrl = config.url ?? "";
        return {
          status: 200,
          statusText: "OK",
          data: { value: "success" },
          headers: { "content-type": "application/json" },
          config,
        };
      };
      expect(await client.getNode({ params: { id: "123" } })).toEqual({
        value: "success",
      });
      expect(requestUrl).toBe("/nodes/123");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("generates standalone validators with typed native schemas and reference support", async () => {
    const document = {
      openapi: "3.1.0",
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          Combined: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              {
                type: "object",
                properties: { count: { type: "number" } },
                required: ["count"],
              },
            ],
            unevaluatedProperties: false,
          },
          Tuple: {
            type: "array",
            prefixItems: [{ type: "string" }],
            unevaluatedItems: false,
          },
        },
      },
      paths: {},
    };
    const result = await generateClient(document, { schemaOnly: true });
    expect(result.diagnostics).toEqual([]);
    expect(
      result.files.filter((file) => file.path.endsWith(".mjs")),
    ).toHaveLength(2);
    expect(result.manifest.outputs).toHaveLength(result.files.length);
    expect(await generateClient(document, { schemaOnly: true })).toEqual(
      result,
    );
    for (const helper of result.files.filter((file) =>
      file.path.endsWith(".mjs"),
    )) {
      expect(helper.content).not.toMatch(/\brequire\s*\(|\beval\s*\(/);
    }
    const directory = await mkdtemp(
      path.join(process.cwd(), ".generator-test-"),
    );
    try {
      await writeGeneratedFiles(result, { outputDir: directory });
      await writeFile(
        path.join(directory, "consumer.ts"),
        `import { Combined } from './client.js';
import { z } from 'zod';
const valid: z.infer<typeof Combined> = { name: 'a', count: 1 };
// @ts-expect-error name is required
const invalid: z.infer<typeof Combined> = { count: 1 };
void valid; void invalid;
`,
      );
      try {
        execFileSync(path.join(process.cwd(), "node_modules/.bin/tsc"), [
          "--ignoreConfig",
          "--noEmit",
          "--strict",
          "--skipLibCheck",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          path.join(directory, "consumer.ts"),
        ]);
      } catch (cause) {
        throw new Error(String((cause as { stdout: Buffer }).stdout));
      }
      const bundle = await build({
        entryPoints: [path.join(directory, "client.ts")],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        external: ["zod"],
      });
      const modulePath = path.join(directory, "bundle.mjs");
      await writeFile(modulePath, bundle.outputFiles[0].text);
      const generated = await import(pathToFileURL(modulePath).href);
      expect(
        generated.Combined.safeParse({ name: "a", count: 1 }).success,
      ).toBe(true);
      expect(
        generated.Combined.safeParse({ name: "a", count: 1, extra: true })
          .success,
      ).toBe(false);
      expect(generated.Tuple.safeParse(["a"]).success).toBe(true);
      expect(generated.Tuple.safeParse(["a", 2]).success).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsupported resource scopes in fallback schemas", async () => {
    const result = await generateClient({
      openapi: "3.1.0",
      components: {
        schemas: {
          Embedded: {
            $id: "https://example.test/schema",
            type: "object",
            unevaluatedProperties: false,
          },
        },
      },
      paths: {},
    });
    expect(result.files).toEqual([]);
    expect(
      result.diagnostics.find(
        (diagnostic) => diagnostic.code === "SCHEMA_COMPILE_ERROR",
      )?.message,
    ).toContain("resource identifiers");
  });

  it("rejects symlinked output directories before writing outside the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "otsc-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "otsc-outside-"));
    try {
      await symlink(outside, path.join(root, "linked"), "dir");
      const result = await generateClient(document, {
        outputFile: "linked/client.ts",
      });
      await expect(
        writeGeneratedFiles(result, { outputDir: root }),
      ).rejects.toThrow("symbolic link");
      await expect(
        readFile(path.join(outside, "client.ts"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("writes only changes, checks drift and rejects paths outside the destination", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "otsc-writer-"));
    try {
      const result = await generateClient(document);
      expect(
        (
          await writeGeneratedFiles(result, {
            outputDir: directory,
            check: true,
          })
        ).changed,
      ).toEqual(["client.ts"]);
      expect(
        (await writeGeneratedFiles(result, { outputDir: directory })).written,
      ).toEqual(["client.ts"]);
      expect(await readFile(path.join(directory, "client.ts"), "utf8")).toBe(
        result.files[0].content,
      );
      expect(
        (await writeGeneratedFiles(result, { outputDir: directory })).unchanged,
      ).toEqual(["client.ts"]);
      await expect(
        writeGeneratedFiles(
          { ...result, files: [{ path: "../escape", content: "" }] },
          { outputDir: directory },
        ),
      ).rejects.toThrow("Invalid or duplicate");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
