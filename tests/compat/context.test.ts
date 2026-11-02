import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { generateZodClientFromOpenAPI, getHandlebars, getZodClientTemplateContext, getOtscEndpointDefinitionList } from '../../src/compat/index.js';

const shared = { $ref: '#/components/schemas/Shared' };
const doc = {
  openapi: '3.1.0',
  info: { title: 'Example', version: '1' },
  components: { schemas: {
    Shared: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    Recursive: { type: 'object', properties: { next: { $ref: '#/components/schemas/Recursive' } } },
  } },
  paths: {
    '/cats/{id}': { parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }], get: { operationId: 'cat', tags: ['Cats', 'Other'], responses: { '200': { content: { 'application/json': { schema: shared } } } } } },
    '/dogs': { post: { operationId: 'dog', tags: ['Dogs'], requestBody: { required: true, content: { 'application/json': { schema: shared } } }, responses: { '201': { content: { 'application/json': { schema: shared } } }, '404': { description: 'Missing' } } } },
    '/old': { get: { deprecated: true, tags: ['Cats'], responses: { '200': {} } } },
  },
};

describe('synchronous compatibility contexts', () => {
  it('builds endpoint lists and grouped schema dependencies for bundled documents', () => {
    const list = getOtscEndpointDefinitionList(doc, { withAlias: true });
    expect(list.endpoints).toHaveLength(2);
    expect(list.endpoints[0]).toMatchObject({ method: 'get', path: '/cats/:id', alias: 'cat', parameters: [{ name: 'id', type: 'Path', schema: 'z.string()' }], response: 'Shared' });
    expect(list.endpoints[1].errors).toEqual([{ status: 404, schema: 'z.void()', description: 'Missing' }]);
    expect(list.resolver.getSchemaByRef('#/components/schemas/Shared')).toEqual(doc.components.schemas.Shared);
    const context = getZodClientTemplateContext(doc, { groupStrategy: 'tag-file' });
    expect(Object.keys(context.endpointsGroups)).toEqual(['Cats', 'Dogs']);
    expect([...context.commonSchemaNames!]).toEqual(['Shared']);
    expect(context.endpointsGroups.Cats.imports).toEqual({ Shared: 'common' });
    expect(context.circularTypeByName.Recursive).toBe(true);
    expect(getOtscEndpointDefinitionList(doc, { withDeprecatedEndpoints: true }).endpoints).toHaveLength(3);
  });

  it('applies schema and endpoint refiners and exposes parent metadata', () => {
    const parentNames: (string | undefined)[] = [];
    const context = getZodClientTemplateContext(doc, {
      withAlias: (route, method) => `${method}_${route.replace(/\W/g, '_')}`,
      schemaRefiner: (schema, meta) => {
        if (meta?.name === 'value') { parentNames.push(meta.parent?.meta.name); return { ...schema, minLength: 3 }; }
        return schema;
      },
      endpointDefinitionRefiner: (endpoint, operation) => ({ ...endpoint, summary: operation.operationId }),
    });
    expect(parentNames).toContain('Shared');
    expect(context.schemas.Shared).toContain('length >= 3');
    expect(context.endpoints[0]).toMatchObject({ alias: 'get__cats__id_', summary: 'cat' });
    expect(doc.components.schemas.Shared.properties.value).toEqual({ type: 'string' });
  });

  it('renders a supplied template with custom helpers and context fields', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'otsc-template-'));
    try {
      const template = path.join(directory, 'template.hbs');
      await writeFile(template, 'import { makeApi } from "otsc";\n{{#each endpoints}}{{shout alias}} {{summary}} {{response}}\n{{/each}}');
      const handlebars = getHandlebars();
      handlebars.registerHelper('shout', (input: string) => input.toUpperCase());
      const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, templatePath: template, handlebars, options: { withAlias: true, endpointDefinitionRefiner: (endpoint, operation) => ({ ...endpoint, summary: operation.operationId }) } });
      expect(output).toContain('from "otsc"');
      expect(output).toContain('CAT cat Shared');
      expect(output).not.toContain('/old');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('renders grouped strings and file records with shared schemas and writes matching files', async () => {
    for (const strategy of ['tag', 'method'] as const) {
      const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, options: { groupStrategy: strategy, withAlias: true } });
      expect(output).toContain('from "otsc"');
      expect(output).toContain(strategy === 'tag' ? 'CatsApi' : 'GetApi');
      expect(output).not.toContain('path: "/old"');
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'otsc-group-'));
    try {
      for (const strategy of ['tag-file', 'method-file'] as const) {
        const destination = path.join(directory, strategy);
        const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, distPath: destination, options: { groupStrategy: strategy, withAlias: true } });
        expect(output.__index).toContain('export');
        expect(output.__common).toContain('export const Shared');
        const group = strategy === 'tag-file' ? 'Cats' : 'get';
        expect(output[group]).toContain('from "./common.js"');
        expect(await readFile(path.join(destination, `${group}.ts`), 'utf8')).toBe(output[group]);
        expect(await readFile(path.join(destination, 'index.ts'), 'utf8')).toBe(output.__index);
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('renders custom templates per file group with their own data', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'otsc-custom-groups-'));
    try {
      const template = path.join(directory, 'template.hbs');
      await writeFile(template, '{{options.apiClientName}}:{{#each endpoints}}{{alias}},{{/each}}{{#each imports}}{{@key}}@{{this}}{{/each}}');
      const output = await generateZodClientFromOpenAPI({ openApiDoc: doc, disableWriteToFile: true, templatePath: template, options: { groupStrategy: 'tag-file', withAlias: true } });
      expect(output.Cats).toContain('CatsApi:cat,Shared@common');
      expect(output.Dogs).toContain('DogsApi:dog,Shared@common');
      expect(output.__index).toContain('CatsApi');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('typechecks generated single and grouped clients against the otsc runtime', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.compat-check-'));
    try {
      await generateZodClientFromOpenAPI({ openApiDoc: doc, distPath: path.join(directory, 'modern.ts') });
      await generateZodClientFromOpenAPI({ openApiDoc: doc, distPath: path.join(directory, 'single.ts'), options: { withAlias: true, schemaRefiner: schema => schema, endpointDefinitionRefiner: (endpoint, operation) => ({ ...endpoint, summary: operation.operationId }) } });
      await generateZodClientFromOpenAPI({ openApiDoc: doc, distPath: path.join(directory, 'grouped'), options: { groupStrategy: 'tag-file', withAlias: true } });
      execFileSync(process.execPath, [path.join(process.cwd(), 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--rootDir', directory, '--outDir', path.join(directory, 'out'), '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', path.join(directory, 'modern.ts'), path.join(directory, 'single.ts'), path.join(directory, 'grouped/index.ts')], { encoding: 'utf8', stdio: 'inherit' });
      const modern = await import(pathToFileURL(path.join(directory, 'out', 'modern.js')).href);
      expect(modern.api.api).toHaveLength(2);
      const relativeClient = modern.createApiClient('', { validate: false });
      const absoluteClient = modern.createApiClient('https://example.test', { validate: false });
      expect(relativeClient.options.validate).toBe(false);
      expect(absoluteClient.options.validate).toBe(false);
      expect(absoluteClient.baseURL).toBe('https://example.test');
      const single = await import(pathToFileURL(path.join(directory, 'out', 'single.js')).href);
      const grouped = await import(pathToFileURL(path.join(directory, 'out', 'grouped', 'index.js')).href);
      expect(single.schemas.Shared.parse({ value: 'valid' })).toEqual({ value: 'valid' });
      expect(single.schemas.Recursive.parse({ next: {} })).toEqual({ next: {} });
      expect(grouped.CatsApi.api[0].alias).toBe('cat');
      expect(grouped.DogsApi.api[0].alias).toBe('dog');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reports unsupported external references and options synchronously', () => {
    const external = { openapi: '3.1.0', components: { schemas: { External: { $ref: './other.yaml#/Thing' } } }, paths: {} };
    expect(() => getZodClientTemplateContext(external)).toThrow('component schema');
    expect(() => getOtscEndpointDefinitionList(doc, { withDocs: true })).toThrow('option withDocs');
  });
});
