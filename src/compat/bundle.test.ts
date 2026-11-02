import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { generateZodClientFromOpenAPI } from './index.js';

it('bundles external path items and cyclic schemas for context options', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otsc-bundle-'));
  try {
    await writeFile(path.join(dir, 'schemas.json'), JSON.stringify({ Node: { type: 'object', properties: { next: { $ref: '#/Node' }, other: { $ref: './same.json#/Node' } } } }));
    await writeFile(path.join(dir, 'same.json'), JSON.stringify({ Node: { type: 'string' } }));
    await writeFile(path.join(dir, 'path.json'), JSON.stringify({ get: { tags: ['pets'], responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: './schemas.json#/Node' } } } } } } }));
    const doc = { openapi: '3.1.0', info: { title: 'test', version: '1' }, paths: { '/pets': { $ref: './path.json' } } };
    const filename = path.join(dir, 'openapi.json');
    await writeFile(filename, JSON.stringify(doc));
    const output = await generateZodClientFromOpenAPI({ openApiDoc: filename, disableWriteToFile: true, options: { groupStrategy: 'tag-file', schemaRefiner: schema => schema } });
    expect(output.pets).toContain('Node_2');
    expect(output.pets).toContain('Node');
    expect(output.pets).toContain('z.lazy');
    expect(output.pets).toContain('/pets');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('assigns stable names independent of reference discovery order and preserves encoded pointers', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'otsc-bundle-'));
  try {
    await writeFile(path.join(dir, 'a.json'), JSON.stringify({ 'odd/%#': { type: 'string' }, Node: { $ref: './b.json#/Node' } }));
    await writeFile(path.join(dir, 'b.json'), JSON.stringify({ Node: { type: 'object', properties: { parent: { $ref: './a.json#/Node' } } } }));
    const makeDoc = (refs: string[]) => ({ openapi: '3.1.0', info: { title: 'test', version: '1' }, paths: {}, components: { schemas: Object.fromEntries(refs.map((ref, i) => [`Root${i}`, { $ref: ref }])) } });
    const { bundleContextDocument } = await import('./bundle.js');
    const base = path.join(dir, 'openapi.json');
    const first = await bundleContextDocument(makeDoc(['./a.json#/Node', './b.json#/Node', './a.json#/odd~1%25%23']), base) as any;
    const second = await bundleContextDocument(makeDoc(['./b.json#/Node', './a.json#/Node', './a.json#/odd~1%25%23']), base) as any;
    expect(first.components.schemas.Node).toEqual(second.components.schemas.Node);
    expect(first.components.schemas.Node_2).toEqual(second.components.schemas.Node_2);
    expect(first.components.schemas.Root2.$ref).toBe('#/components/schemas/odd_');
    const special = { openapi: '3.1.0', info: { title: 'test', version: '1' }, paths: {}, components: { schemas: { 'odd/%#': { type: 'string' }, Alias: { $ref: '#/components/schemas/odd~1%25%23' } } } };
    const bundled = await bundleContextDocument(special, special);
    const { getZodClientTemplateContext } = await import('./index.js');
    expect(getZodClientTemplateContext(bundled).schemas.Alias).toContain('odd_');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
