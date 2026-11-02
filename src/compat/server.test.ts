import { describe, expect, it } from 'vitest';
import { generateZodClientFromOpenAPI } from './index.js';

describe('referenced path items', () => {
  it('uses the document server unless a base URL is provided', async () => {
    const document = {
      openapi: '3.1.0',
      info: { title: 'Example', version: '1.0.0' },
      servers: [{ url: 'https://{region}.example.test', variables: { region: { default: 'us' } } }],
      paths: { '/pets': { $ref: '#/components/pathItems/Pets' } },
      components: { pathItems: { Pets: { get: { responses: { '200': { description: 'OK' } } } } } },
    };

    const generated = await generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true });
    expect(generated).toContain('https://us.example.test');
    expect(generated).toContain('"/pets"');

    const overridden = await generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true, options: { baseUrl: 'https://override.example.test' } });
    expect(overridden).toContain('https://override.example.test');
    expect(overridden).not.toContain('https://us.example.test');
  });
});
