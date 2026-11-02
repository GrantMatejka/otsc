import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';
import { compileSchema } from '../../src/generator/schema/index.js';

function generated(schema: unknown): z.ZodType {
  const source = compileSchema(schema);
  const javascript = `return (${source});`.replaceAll(': unknown', '').replaceAll(': boolean', '').replaceAll(' as Record<string, unknown>', '').replaceAll(': number', '').replaceAll(' as const', '').replaceAll('mantissa!', 'mantissa').replaceAll('whole!', 'whole');
  return new Function('z', javascript)(z) as z.ZodType;
}

const examples: { name: string; schema: unknown; values: unknown[] }[] = [
  {
    name: 'not with sibling and nested composition',
    schema: { type: 'number', not: { anyOf: [{ minimum: 3 }, { maximum: 0 }] } },
    values: [-1, 0, 1, 2, 3, 4, '1', null],
  },
  {
    name: 'conditional checks the entire original object',
    schema: { if: { properties: { kind: { const: 'a' } }, required: ['kind'] }, then: { required: ['alpha'] }, else: { required: ['beta'] }, properties: { kind: { type: 'string' } } },
    values: [{ kind: 'a', alpha: 1 }, { kind: 'a', beta: 1 }, { kind: 'b', beta: 1 }, {}, { beta: null }, null, 1],
  },
  {
    name: 'dependent schemas and dependent required use property presence',
    schema: { dependentRequired: { credit: ['billing'], billing: ['name'] }, dependentSchemas: { credit: { properties: { credit: { type: 'number' } }, required: ['active'] } } },
    values: [{}, { credit: 1 }, { credit: 1, billing: true, name: 'n', active: true }, { credit: '1', billing: true, name: 'n', active: true }, { billing: null, name: null }, [], null],
  },
  {
    name: 'overlapping property patterns and additional properties',
    schema: { type: 'object', properties: { fixed: { type: 'string' } }, patternProperties: { '^x': { type: 'number' }, 'z$': { minimum: 2 } }, additionalProperties: false, propertyNames: { minLength: 2 } },
    values: [{}, { fixed: 'a', xx: 1, xz: 2, zz: 3 }, { xz: 1 }, { xz: 'x' }, { zz: 1 }, { extra: 4 }, { x: 1 }, 5],
  },
  {
    name: 'typed additional properties exclude every matching pattern',
    schema: { patternProperties: { '^S_': { type: 'string' }, '^N_': { type: 'number' } }, additionalProperties: { type: 'boolean' } },
    values: [{ S_a: 'a', N_b: 1, other: true }, { S_a: true }, { N_b: 1, other: 1 }, null, []],
  },
  {
    name: 'prefix items are optional and items applies only to the tail',
    schema: { type: 'array', prefixItems: [{ type: 'string' }, { type: 'integer' }], items: { type: 'boolean' } },
    values: [[], ['a'], ['a', 1], ['a', 1, true, false], ['a', 1, 2], [1], ['a', '1'], 1],
  },
  {
    name: 'contains count and other array constraints',
    schema: { type: 'array', prefixItems: [{ type: 'number' }], contains: { type: 'string' }, minContains: 1, maxContains: 2, minItems: 2 },
    values: [[1, 'a'], [1, 'a', 'b'], [1, 'a', 'b', 'c'], [1, 2], ['a', 1], [], null],
  },
  {
    name: 'zero contains count and absent contains',
    schema: { contains: { type: 'number' }, minContains: 0, maxContains: 0 },
    values: [[], ['a'], ['a', 2], [2], {}, null],
  },
  {
    name: 'oneOf counts matching tuple schemas exactly',
    schema: { oneOf: [{ prefixItems: [{ type: 'number' }] }, { contains: { type: 'number' } }] },
    values: [[], [1], ['x', 1], ['x'], [1, 'x'], [null, 1], null],
  },
  {
    name: 'composition does not merge closed schemas',
    schema: { allOf: [{ patternProperties: { '^x': { type: 'number' } }, additionalProperties: false }, { required: ['y'] }] },
    values: [{}, { x: 1 }, { y: 1 }, { x: 1, y: 2 }, 2],
  },
];

describe('2020-12 conformance against an independent validator', () => {
  for (const example of examples) {
    it(example.name, () => {
      const oracle = new Ajv2020({ strict: false }).compile(example.schema as object);
      const compiled = generated(example.schema);
      for (const value of example.values) {
        expect(compiled.safeParse(value).success, JSON.stringify(value)).toBe(oracle(value));
      }
    });
  }
  it('preserves patterned and tail values in parsed output', () => {
    const object = { S_name: 'value', other: true };
    expect(generated({ type: 'object', patternProperties: { '^S_': { type: 'string' } }, additionalProperties: { type: 'boolean' } }).parse(object)).toEqual(object);
    const array = ['value', 3, false];
    expect(generated({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: { type: 'boolean' } }).parse(array)).toEqual(array);
  });
  it('ignores then and else without if, and contains counts without contains', () => {
    const compiled = generated({ then: false, else: false, minContains: 7, maxContains: 0 });
    for (const value of [null, [], [1], {}, 'x']) expect(compiled.safeParse(value).success).toBe(true);
  });
  it('rejects malformed nested schemas with escaped source pointers', () => {
    expect(() => compileSchema({ patternProperties: { 'bad/[': true } }, { pointer: '#/root' })).toThrow('#/root/patternProperties/bad~1[');
    expect(() => compileSchema({ dependentSchemas: { 'a~b': { not: { unsupportedKeyword: true } } } })).toThrow('#/dependentSchemas/a~0b/not/unsupportedKeyword');
    expect(() => compileSchema({ prefixItems: [{ type: 'string' }, 12] })).toThrow('#/prefixItems/1');
    expect(() => compileSchema({ contains: true, minContains: -1 })).toThrow('#/minContains');
    expect(() => compileSchema({ dependentRequired: { a: ['b', 'b'] } })).toThrow('#/dependentRequired/a');
    expect(() => compileSchema({ prefixItems: [true] }, { dialect: '3.0' })).toThrow('#/prefixItems');
  });
});
