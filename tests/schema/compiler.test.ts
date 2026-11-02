import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { compileSchema } from '../../src/generator/schema/index.js';

function validator(schema: unknown, options: Parameters<typeof compileSchema>[1] = {}, references: Record<string, z.ZodType> = {}): z.ZodType {
  const source = compileSchema(schema, options);
  const javascript = `return (${source});`.replaceAll(': unknown', '').replaceAll(': boolean', '').replaceAll(' as Record<string, unknown>', '').replaceAll(': number', '').replaceAll(' as const', '').replaceAll('mantissa!', 'mantissa').replaceAll('whole!', 'whole');
  return new Function('z', ...Object.keys(references), javascript)(z, ...Object.values(references)) as z.ZodType;
}

function accepts(schema: z.ZodType, valid: unknown[], invalid: unknown[]): void {
  for (const value of valid) expect(schema.safeParse(value).success, `should accept ${JSON.stringify(value)}`).toBe(true);
  for (const value of invalid) expect(schema.safeParse(value).success, `should reject ${JSON.stringify(value)}`).toBe(false);
}

describe('schema compiler', () => {
  it('preserves optional, required, nullable and unknown properties', () => {
    const schema = validator({ type: 'object', properties: { name: { type: 'string' }, age: { type: ['integer', 'null'] } }, required: ['name', 'other'] });
    accepts(schema, [{ name: 'a', other: 1, age: null }, { name: 'a', other: null, extra: true }], [{ other: 1 }, { name: 'a' }, { name: 'a', other: 1, age: '2' }]);
    expect(schema.parse({ name: 'a', other: 1, extra: true })).toEqual({ name: 'a', other: 1, extra: true });
  });
  it('treats undefined required names as additional properties', () => {
    accepts(validator({ type: 'object', required: ['x'], additionalProperties: false }), [], [{}, { x: 1 }]);
    accepts(validator({ type: 'object', required: ['x'], additionalProperties: { type: 'string' } }), [{ x: 'ok' }], [{ x: 1 }, {}]);
  });
  it('enforces exact oneOf, including overlapping branches and siblings', () => {
    const schema = validator({ type: 'number', minimum: 0, oneOf: [{ type: 'number' }, { type: 'integer' }] });
    accepts(schema, [0.5], [-0.5, 1, 'a']);
  });
  it('keeps allOf closed object rules and avoids stripping keys', () => {
    const schema = validator({ allOf: [{ type: 'object', properties: { x: { type: 'string' } }, additionalProperties: false }, { type: 'object', properties: { y: { type: 'number' } }, required: ['y'] }] });
    accepts(schema, [], [{ x: 'a', y: 1 }, { y: 1 }, {}]);
  });
  it('resolves references and enforces their siblings', () => {
    const schema = validator({ $ref: '#/Foo', minLength: 3 }, { resolveRef: () => 'Foo' }, { Foo: z.string() });
    accepts(schema, ['abcd'], ['ab', 5]);
  });
  it('supports caller-provided lazy recursive references', () => {
    let node: z.ZodType;
    const lazy = z.lazy(() => node);
    node = validator({ type: 'object', properties: { value: { type: 'string' }, next: { $ref: '#/Node' } }, required: ['value'] }, { resolveRef: () => 'Node' }, { Node: lazy });
    accepts(node, [{ value: 'a', next: { value: 'b' } }], [{ value: 'a', next: { value: 1 } }]);
  });
  it('applies constraints only to relevant instance types', () => {
    const schema = validator({ minLength: 2, minimum: 0, properties: { x: { type: 'boolean' } } });
    accepts(schema, ['ab', 1, { x: true }, null], ['a', -1, { x: 1 }]);
  });
  it('handles Unicode lengths, zero bounds and both exclusive-bound dialects', () => {
    accepts(validator({ type: 'string', minLength: 1, maxLength: 1 }), ['😀', 'x'], ['', 'ab']);
    accepts(validator({ type: 'number', minimum: 0, exclusiveMinimum: true }, { dialect: '3.0' }), [1], [0, -1]);
    accepts(validator({ type: 'number', exclusiveMaximum: 0 }, { dialect: '3.1' }), [-1], [0, 1]);
    accepts(validator({ type: 'string', nullable: true }, { dialect: '3.0' }), [null, 'a'], [1]);
  });
  it('checks decimal multiples without floating point tolerances', () => {
    accepts(validator({ type: 'number', multipleOf: 0.1 }), [0, 0.3, -0.2], [0.30000000000000004, 0.01]);
  });
  it('compares structured JSON enum and array values structurally', () => {
    accepts(validator({ enum: [{ a: 1, b: [2] }, null, 2] }), [{ b: [2], a: 1 }, null, 2], [{ a: 1, b: [3] }, '2']);
    accepts(validator({ type: 'array', uniqueItems: true }), [[{ a: 1 }, { a: 2 }]], [[{ a: 1, b: 2 }, { b: 2, a: 1 }]]);
  });
  it('rejects unsupported assertions and malformed inputs with pointers', () => {
    expect(() => compileSchema({ properties: { 'a/b': { contains: { unevaluatedItems: false } } } }, { pointer: '#/schema' })).toThrow('#/schema/properties/a~1b/contains/unevaluatedItems');
    expect(() => compileSchema({ unevaluatedProperties: false })).toThrow('unsupported schema keyword');
    expect(() => compileSchema({ $ref: '#/x' })).toThrow('resolver is required');
    expect(() => compileSchema({ $ref: '#/x' }, { resolveRef: () => 'x);evil(' })).toThrow('valid reference identifier');
    expect(() => compileSchema({ minLength: -1 })).toThrow('#/minLength');
  });
  it('compiles boolean schemas and safely quotes source data', () => {
    accepts(validator(true), [null, {}, 3], []);
    accepts(validator(false), [], [null, {}, 3]);
    const value = '"\\\n${evil()}';
    accepts(validator({ type: 'object', properties: { [value]: { const: value } }, required: [value] }), [{ [value]: value }], [{ [value]: 'other' }]);
  });
});
