import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { generateZodClientFromOpenAPI } from './index.js';

const root = {
  openapi: '3.1.0', info: { title: 'Example', version: '1' },
  paths: { '/pets': { $ref: './paths.json#/pets' } },
};
const paths = { pets: {
  get: { deprecated: true, responses: { '200': { description: 'Old' } } },
  post: { responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: './schemas.json#/Pet' } } } } } },
} };
const schemas = { Pet: { type: 'object', properties: { name: { type: 'string' } } } };

describe('deprecated endpoint filtering', () => {
  it('preserves the base URI of referenced file path items and schemas', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'compat-'));
    try {
      await Promise.all(Object.entries({ 'openapi.json': root, 'paths.json': paths, 'schemas.json': schemas }).map(([name, value]) => writeFile(path.join(dir, name), JSON.stringify(value))));
      const output = await generateZodClientFromOpenAPI({ openApiDoc: path.join(dir, 'openapi.json'), disableWriteToFile: true });
      expect(output).toContain('method: "post"');
      expect(output).not.toContain('method: "get"');
      expect(output).toContain('["name"]: z.string()');
      const all = await generateZodClientFromOpenAPI({ openApiDoc: path.join(dir, 'openapi.json'), disableWriteToFile: true, options: { withDeprecatedEndpoints: true } });
      expect(all).toContain('method: "get"');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('preserves HTTP references and relative server URLs', async () => {
    const documents: Record<string, unknown> = { '/api/openapi.json': { ...root, servers: [{ url: '../service' }] }, '/api/paths.json': paths, '/api/schemas.json': schemas };
    const server = createServer((request, response) => {
      const body = documents[request.url ?? ''];
      response.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body ?? {}));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No server address');
      const origin = `http://127.0.0.1:${address.port}`;
      const output = await generateZodClientFromOpenAPI({ openApiDoc: `${origin}/api/openapi.json`, disableWriteToFile: true });
      expect(output).toContain(`${origin}/service`);
      expect(output).toContain('method: "post"');
      expect(output).not.toContain('method: "get"');
      expect(output).toContain('["name"]: z.string()');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
});
