import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { projectSchema, ProjectionError, type OpenAPIDialect } from '../../src/generator/projection/index.js';

describe('schema projection', () => {
  for (const dialect of ['3.0', '3.1', '3.2'] as OpenAPIDialect[]) {
    it(`projects required properties in ${dialect} without discarding constraints`, () => {
      const source = { type: 'object', additionalProperties: false, required: ['identifier', 'secret', 'name'], properties: { identifier: { type: 'integer', minimum: 1, readOnly: true }, secret: { type: 'string', minLength: 3, writeOnly: true }, name: { type: 'string' } } };
      const snapshot = structuredClone(source);
      const request = projectSchema(source, { direction: 'request', dialect }).schema;
      const response = projectSchema(source, { direction: 'response', dialect }).schema;
      expect(request).toEqual({ ...source, required: ['secret', 'name'] });
      expect(response).toEqual({ ...source, required: ['identifier', 'name'] });
      expect(source).toEqual(snapshot);
      const validate = new Ajv2020({ strict: false }).compile(request as object);
      expect(validate({ secret: 'abc', name: 'n' })).toBe(true);
      expect(validate({ identifier: 0, secret: 'abc', name: 'n' })).toBe(false);
      expect(validate({ secret: 'abc', name: 'n', extra: true })).toBe(false);
    });
  }

  it('projects nested compositions, arrays, and allOf split required declarations', () => {
    const source = { allOf: [{ properties: { id: { readOnly: true, type: 'integer' } } }, { required: ['id', 'items'] }], properties: { items: { type: 'array', items: { oneOf: [{ properties: { secret: { writeOnly: true } }, required: ['secret'] }, { anyOf: [{ type: 'string' }, { type: 'number' }] }] } } } };
    const result = projectSchema(source, { direction: 'request', dialect: '3.1' }).schema as any;
    expect(result.allOf[1].required).toEqual(['items']);
    expect(result.properties.items.items.oneOf[0].required).toEqual(['secret']);
    const response = projectSchema(source, { direction: 'response', dialect: '3.1' }).schema as any;
    expect(response.properties.items.items.oneOf[0].required).toEqual([]);
  });

  it('uses canonical keys and source scope for cyclic and shared references', () => {
    const node = { type: 'object', required: ['id', 'next'], properties: { id: { $ref: 'id' }, next: { $ref: 'node' }, other: { $ref: 'node' } } };
    const identifier = { type: 'integer', readOnly: true };
    const result = projectSchema({ $ref: 'node' }, { direction: 'request', dialect: '3.1', rootKey: 'root', resolveRef(reference, from) {
      if (reference === 'node') return { key: 'node', schema: node };
      if (reference === 'id' && from === 'node') return { key: 'id', schema: identifier };
      throw new Error('unexpected reference');
    } });
    const projectedNode = result.resolveRef('node') as any;
    expect(projectedNode.required).toEqual(['next']);
    expect(result.resolveRef('node', 'node')).toBe(projectedNode);
    expect(result.resolveRef('id', 'node')).toEqual(identifier);
    expect(result.references.size).toBe(2);
    expect(() => result.resolveRef('id')).toThrow(ProjectionError);
  });

  it('honors reference siblings in 3.1 and ignores them in 3.0', () => {
    const schema = { required: ['id'], properties: { id: { $ref: 'id', readOnly: true, minimum: 4 } } };
    const resolveRef = () => ({ key: 'id', schema: { type: 'integer' } });
    expect((projectSchema(schema, { direction: 'request', dialect: '3.1', resolveRef }).schema as any).required).toEqual([]);
    expect((projectSchema(schema, { direction: 'request', dialect: '3.0', resolveRef }).schema as any).required).toEqual(['id']);
    const inherited = { required: ['id'], properties: { id: { $ref: 'id', readOnly: true } } };
    expect((projectSchema(inherited, { direction: 'request', dialect: '3.0', resolveRef: () => ({ key: 'id', schema: { readOnly: true } }) }).schema as any).required).toEqual([]);
  });

  it('allows explicit property removal', () => {
    const source = { properties: { id: { readOnly: true }, name: { type: 'string' } }, required: ['id', 'name'] };
    expect(projectSchema(source, { direction: 'request', dialect: '3.1', excludedProperties: 'remove' }).schema).toEqual({ properties: { name: { type: 'string' } }, required: ['name'] });
  });

  it('rejects a shared reference when its projection depends on the surrounding composition', () => {
    const schema = { allOf: [{ properties: { id: { readOnly: true } } }, { $ref: 'shared' }], properties: { nested: { $ref: 'shared' } } };
    expect(() => projectSchema(schema, { direction: 'request', dialect: '3.1', resolveRef: () => ({ key: 'shared', schema: { required: ['id'] } }) })).toThrow(/incompatible projection contexts/);
  });

  it('reports ambiguous composition and missing references', () => {
    expect(() => projectSchema({ required: ['id'], properties: { id: { oneOf: [{ readOnly: true }, { type: 'string' }] } } }, { direction: 'request', dialect: '3.1' })).toThrow(/Ambiguous oneOf/);
    expect(() => projectSchema({ required: ['id'], anyOf: [{ properties: { id: { readOnly: true } } }, {}] }, { direction: 'request', dialect: '3.1' })).toThrow(/Ambiguous anyOf/);
    expect(() => projectSchema({ allOf: [{ required: ['id'] }, { anyOf: [{ properties: { id: { readOnly: true } } }, {}] }] }, { direction: 'request', dialect: '3.1' })).toThrow(/Ambiguous anyOf/);
    expect(() => projectSchema({ $ref: 'missing' }, { direction: 'request', dialect: '3.1' })).toThrow(/No resolver/);
  });
});
