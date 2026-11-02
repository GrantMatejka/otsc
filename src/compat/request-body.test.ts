import { describe, expect, it } from 'vitest';
import { getZodClientTemplateContext, generateZodClientFromOpenAPI } from './index.js';

describe('request body media types', () => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Service', version: '1' },
    paths: { '/upload': { post: {
      requestBody: { required: true, content: {
        'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } },
        'text/plain': { schema: { type: 'string' } },
      } },
      responses: { '204': { description: 'Done' } },
    } } },
  };

  it('retains every media contract and combines the body types', async () => {
    const context = getZodClientTemplateContext(document, { withDescription: true });
    const endpoint = context.endpoints[0];
    expect(endpoint.requestBodies).toMatchObject([
      { mediaType: 'application/json', required: true },
      { mediaType: 'text/plain', required: true },
    ]);
    expect(endpoint.parameters.find(parameter => parameter.type === 'Body')?.schema).toContain('z.union(');
    const output = await generateZodClientFromOpenAPI({ openApiDoc: document, disableWriteToFile: true, options: { withDescription: true } });
    expect(output).toContain('text/plain');
    expect(output).toContain('application/json');
  });

  it('rejects unsupported media instead of silently dropping it', () => {
    const invalid = structuredClone(document);
    Object.assign(invalid.paths['/upload'].post.requestBody.content, { 'application/custom': { schema: { type: 'string' } } });
    expect(() => getZodClientTemplateContext(invalid)).toThrow('unsupported request media type application/custom');
  });
});
