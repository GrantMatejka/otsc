import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CodeMeta, generateZodClientFromOpenAPI, getHandlebars, getOpenApiDependencyGraph, getZodClientTemplateContext, getZodSchema, getOtscEndpointDefinitionList, maybePretty } from '../../src/compat/index.js';

const document = {
  openapi: '3.1.0',
  info: { title: 'Example', version: '1' },
  components: { schemas: { Item: { type: 'string' } } },
  paths: { '/items': { get: { operationId: 'listItems', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } } } },
};

describe('OTSC compatibility', () => {
  it('generates a no-write client using the otsc runtime and legacy client name', async () => {
    const output = await generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true, options: { baseUrl: 'https://example.test', apiClientName: 'client', withAlias: true } });
    expect(output).toContain('from "otsc"');
    expect(output).toContain('from "zod"');
    expect(output).toContain('alias: "listItems"');
    expect(output).toContain('export const client = createApiClient()');
    expect(output).toContain('https://example.test');
    const withoutAlias = await generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true });
    expect(withoutAlias).not.toContain('alias:');
    expect(withoutAlias).toContain('export const api = createApiClient()');
  });

  it('loads YAML and writes the same string returned to the caller', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'otsc-compat-'));
    try {
      const input = path.join(directory, 'spec.yaml');
      const outputPath = path.join(directory, 'nested', 'client.ts');
      await writeFile(input, 'openapi: 3.1.0\npaths: {}\n');
      const output = await generateZodClientFromOpenAPI({ openApiDoc: input, distPath: outputPath, prettierConfig: { singleQuote: true } });
      expect(output).toContain("from 'otsc'");
      expect(await readFile(outputPath, 'utf8')).toBe(output);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('rejects unsupported settings and ambiguous generator diagnostics', async () => {
    for (const options of [{ withDefaultValues: true }, { isMainResponseStatus: 'status > 200' }, { isErrorStatus: 'status > 400' }, { isMediaTypeAllowed: 'true' }, { useMainResponseDescriptionAsEndpointDefinitionFallback: true }, { shouldExportAllSchemas: true }, { shouldExportAllTypes: true }, { withImplicitRequiredProps: true }, { withDocs: true }, { complexityThreshold: 0 }, { defaultStatusBehavior: 'auto-correct' }, { willSuppressWarnings: true }, { withDescription: true }, { allReadonly: true }, { strictObjects: true }, { additionalPropertiesDefaultValue: true }, { withAllResponses: true }, { exportAllNamedSchemas: true }, { mystery: true }]) {
      await expect(generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true, options: options as never })).rejects.toThrow('not supported');
    }
    await expect(generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true, options: { apiClientName: 'class' } })).rejects.toThrow('apiClientName');
    const multi = { openapi: '3.1.0', paths: { '/': { get: { responses: { '200': {}, '201': {} } } } } };
    const multiOutput = await generateZodClientFromOpenAPI({ openApiDoc: multi, disableWriteToFile: true });
    expect(multiOutput).toContain('status: 201');
    const deprecated = { openapi: '3.1.0', paths: { '/': { get: { deprecated: true, responses: { '200': {} } } } } };
    const withoutDeprecated = await generateZodClientFromOpenAPI({ openApiDoc: deprecated, disableWriteToFile: true });
    expect(withoutDeprecated).not.toContain('method:');
    await expect(generateZodClientFromOpenAPI({ openApiDoc: deprecated, disableWriteToFile: true, options: { withDeprecatedEndpoints: true } })).resolves.toContain('endpoints');
  });

  it('exposes isolated Handlebars helpers and async Prettier fallback', async () => {
    const handlebars = getHandlebars();
    expect(handlebars.compile('{{#ifeq left right}}same{{else}}different{{/ifeq}} {{#ifNotEmptyObj data}}yes{{/ifNotEmptyObj}} {{toCamelCase name}}')({ left: 'x', right: 'x', data: { present: 1 }, name: 'MY_NAME' })).toBe('same yes myName');
    handlebars.registerHelper('custom', () => 'custom');
    expect(getHandlebars().helpers.custom).toBeUndefined();
    expect(await maybePretty('const value={x:1}', { singleQuote: true })).toContain('const value = { x: 1 };');
    expect(await maybePretty('const =')).toBe('const =');
  });

  it('compiles standalone schemas and tracks direct and recursive dependencies', () => {
    const meta = getZodSchema({ schema: { type: 'string', minLength: 2 } });
    expect(meta).toBeInstanceOf(CodeMeta);
    expect(meta.toString()).toContain('Array.from(value).length >= 2');
    const refined = getZodSchema({ schema: { type: 'string' }, options: { schemaRefiner: schema => ({ ...schema, minLength: 4 }) } });
    expect(refined.toString()).toContain('length >= 4');
    expect(() => getZodSchema({ schema: { $ref: '#/missing' } })).toThrow();
    const schemas: Record<string, Record<string, unknown>> = {
      A: { type: 'object', properties: { child: { $ref: 'B' } } },
      B: { type: 'array', items: { $ref: 'A' } },
      C: { type: 'string' },
    };
    const graph = getOpenApiDependencyGraph(['A', 'B', 'C'], ref => schemas[ref]);
    expect([...graph.refsDependencyGraph.A]).toEqual(['B']);
    expect([...graph.deepDependencyGraph.A]).toEqual(['B', 'A']);
    expect(graph.deepDependencyGraph.C).toBeUndefined();
    expect(getZodClientTemplateContext(document).endpoints).toHaveLength(1);
    expect(getOtscEndpointDefinitionList(document).endpoints).toHaveLength(1);
  });
});
