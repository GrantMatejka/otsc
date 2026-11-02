import { describe, expect, it } from 'vitest';
import { compileSchema } from '../../src/generator/schema/index.js';

describe('schema source reproducibility', () => {
  it('emits the same source for shuffled schema maps and structured JSON values', () => {
    const first = {
      type: 'object',
      properties: {
        zebra: { const: { second: 2, first: { beta: true, alpha: [1, 2] } } },
        apple: { type: 'string' },
      },
      patternProperties: { '^z': { type: 'number' }, '^a': { type: 'boolean' } },
      additionalProperties: false,
      dependentRequired: { zebra: ['apple'], apple: ['zebra'] },
      dependentSchemas: { zebra: { minProperties: 1 }, apple: { maxProperties: 4 } },
    };
    const shuffled = {
      dependentSchemas: { apple: { maxProperties: 4 }, zebra: { minProperties: 1 } },
      dependentRequired: { apple: ['zebra'], zebra: ['apple'] },
      additionalProperties: false,
      patternProperties: { '^a': { type: 'boolean' }, '^z': { type: 'number' } },
      properties: {
        apple: { type: 'string' },
        zebra: { const: { first: { alpha: [1, 2], beta: true }, second: 2 } },
      },
      type: 'object',
    };
    expect(compileSchema(first)).toBe(compileSchema(shuffled));
  });

  it('preserves ordering of composition branches and tuple prefixes', () => {
    const stringSchema = { type: 'string' };
    const numberSchema = { type: 'number' };
    expect(compileSchema({ anyOf: [stringSchema, numberSchema] })).not.toBe(compileSchema({ anyOf: [numberSchema, stringSchema] }));
    expect(compileSchema({ prefixItems: [stringSchema, numberSchema] })).not.toBe(compileSchema({ prefixItems: [numberSchema, stringSchema] }));
    expect(compileSchema({ const: { values: [1, 2] } })).not.toBe(compileSchema({ const: { values: [2, 1] } }));
  });
});
