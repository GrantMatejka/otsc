import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { compileStandaloneValidator } from '../../src/generator/validation/index.js';

type Validator = ((value: unknown) => boolean) & { errors?: unknown };

function browserValidator(source: string): Validator {
  return runInNewContext(source, {}, { codeGeneration: { strings: false, wasm: false } }) as Validator;
}

const conditionalSchema = {
  type: 'object',
  properties: { kind: { enum: ['named', 'numbered'] } },
  required: ['kind'],
  if: { properties: { kind: { const: 'named' } } },
  then: { properties: { name: { type: 'string', minLength: 2 } }, required: ['name'] },
  else: { properties: { number: { type: 'integer' } }, required: ['number'] },
  unevaluatedProperties: false,
};

describe('standalone JSON Schema validation', () => {
  it('enforces conditionals and unevaluated properties in a browser-like context', () => {
    const source = compileStandaloneValidator(conditionalSchema);
    const validate = browserValidator(source);
    expect(validate({ kind: 'named', name: 'Ada' })).toBe(true);
    expect(validate({ kind: 'numbered', number: 2 })).toBe(true);
    expect(validate({ kind: 'named', name: 'A' })).toBe(false);
    expect(validate({ kind: 'numbered', number: 2, extra: true })).toBe(false);
    expect(validate.errors).toBeTruthy();
    expect(source).toBe(compileStandaloneValidator(conditionalSchema));
  });

  it('resolves relative cross-resource references and bundles Ajv helpers', async () => {
    const schema = {
      $id: 'https://example.test/root',
      type: 'object',
      properties: { record: { $ref: 'record' }, code: { type: 'string', format: 'email' } },
      required: ['record', 'code'],
    };
    const options = { assertFormats: true, rootId: 'https://example.test/root', resources: [{ id: 'https://example.test/record', schema: { type: 'array', uniqueItems: true, items: { type: 'object' } } }] };
    const source = compileStandaloneValidator(schema, options);
    const browser = browserValidator(source);
    const valid = { record: [{ id: 1 }, { id: 2 }], code: 'person@example.com' };
    const invalid = { record: [{ id: 1 }, { id: 1 }], code: 'person@example.com' };
    expect(browser(valid)).toBe(true);
    expect(browser(invalid)).toBe(false);
    expect(browser({ ...valid, code: 'invalid' })).toBe(false);
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(`export default ${source};`).toString('base64')}`;
    const imported = await import(moduleUrl) as { default: Validator };
    expect(imported.default(valid)).toBe(true);
    expect(imported.default(invalid)).toBe(false);
    const result = execFileSync(process.execPath, ['--input-type=commonjs', '-e', `const validate = ${source}; process.stdout.write(JSON.stringify([validate(${JSON.stringify(valid)}), validate(${JSON.stringify(invalid)})]));`], { encoding: 'utf8' });
    expect(JSON.parse(result)).toEqual([true, false]);
  });

  it('does not coerce, remove properties, or apply defaults', () => {
    const schema = { type: 'object', properties: { count: { type: 'integer', default: 3 } }, additionalProperties: false };
    const validate = browserValidator(compileStandaloneValidator(schema));
    const missing = {};
    const invalid = { count: '3', extra: true };
    expect(validate(missing)).toBe(true);
    expect(missing).toEqual({});
    expect(validate(invalid)).toBe(false);
    expect(invalid).toEqual({ count: '3', extra: true });
    expect(schema.properties.count.default).toBe(3);
  });

  it('validates only own object properties, including prototype-named JSON keys', () => {
    const schema = {
      type: 'object',
      properties: { toString: { type: 'string' }, value: { type: 'number' } },
      required: ['toString'],
      dependentRequired: { value: ['toString'] },
      unevaluatedProperties: false,
    };
    const validate = browserValidator(compileStandaloneValidator(schema));
    expect(validate({})).toBe(false);
    expect(validate({ value: 1 })).toBe(false);
    expect(validate(JSON.parse('{"toString":"ok","value":1}'))).toBe(true);
    expect(validate(JSON.parse('{"toString":1}'))).toBe(false);
    expect(validate(Object.assign(Object.create({ extra: true }), { toString: 'ok' }))).toBe(true);
    expect(validate(JSON.parse('{"toString":"ok","extra":true}'))).toBe(false);
  });

  it('validates decimal multipleOf without binary floating-point division errors', () => {
    const validate = browserValidator(compileStandaloneValidator({ type: 'number', multipleOf: 0.1 }));
    expect(validate(0.3)).toBe(true);
    expect(validate(-0.3)).toBe(true);
    expect(validate(0)).toBe(true);
    expect(validate(0.31)).toBe(false);
    expect(validate(0.30000000000000004)).toBe(false);
  });

  it('reports unsupported dialects, vocabularies, references and unknown keywords', () => {
    expect(() => compileStandaloneValidator({ $schema: 'http://json-schema.org/draft-07/schema#' })).toThrow('unsupported JSON Schema dialect');
    expect(() => compileStandaloneValidator({ properties: { item: { $schema: 'https://example.test/dialect' } } })).toThrow('#/properties/item/$schema');
    expect(() => compileStandaloneValidator({ $vocabulary: { 'https://example.test/vocab': true } })).toThrow('vocabularies are unsupported');
    expect(() => compileStandaloneValidator({ $ref: 'https://example.test/missing' })).toThrow(/resolve reference/i);
    expect(() => compileStandaloneValidator({ $dynamicRef: '#anchor' })).toThrow(/\$dynamicRef/);
    expect(() => compileStandaloneValidator({ $defs: { embedded: { $id: 'other' } } })).toThrow(/embedded schema resources/);
    expect(() => compileStandaloneValidator({ unknownAssertion: true })).toThrow(/unknown keyword/);
    expect(browserValidator(compileStandaloneValidator({ type: 'string', format: 'made-up-format' }))('value')).toBe(true);
    expect(() => compileStandaloneValidator({ format: 'made-up-format' }, { assertFormats: true })).toThrow(/unknown format/);
  });

  it('supports boolean schemas and rejects non-JSON input', () => {
    expect(browserValidator(compileStandaloneValidator(true))(null)).toBe(true);
    expect(browserValidator(compileStandaloneValidator(false))(null)).toBe(false);
    expect(() => compileStandaloneValidator({ const: undefined })).toThrow('JSON value');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => compileStandaloneValidator(cyclic)).toThrow('acyclic JSON');
  });
});
