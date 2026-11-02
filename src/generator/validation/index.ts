import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { _ } from 'ajv/dist/compile/codegen/index.js';
import { _Code } from 'ajv/dist/compile/codegen/code.js';
import standaloneModule from 'ajv/dist/standalone/index.js';
import formatsModule from 'ajv-formats';
import { buildSync } from 'esbuild';
import { isSupportedSchemaDialect } from '../dialect.js';

export interface StandaloneValidatorOptions {
  resources?: readonly { id: string; schema: unknown }[];
  rootId?: string;
  assertFormats?: boolean;
}

const standaloneCode = standaloneModule as unknown as typeof import('ajv/dist/standalone/index.js').default;
const addFormats = formatsModule as unknown as typeof import('ajv-formats').default;

const dialect = 'https://json-schema.org/draft/2020-12/schema';
const schemaMaps = new Set(['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaValues = new Set(['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'contains', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema']);

function exactMultipleOf(value: number, divisor: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) return false;
  const decimal = (numberValue: number): readonly [bigint, number] => {
    const [mantissa, exponent] = numberValue.toString().toLowerCase().split('e');
    const [whole, fraction = ''] = mantissa!.split('.');
    return [BigInt(whole! + fraction), Number(exponent || 0) - fraction.length];
  };
  const [numerator, numeratorExponent] = decimal(value);
  const [denominator, denominatorExponent] = decimal(divisor);
  const shift = numeratorExponent - denominatorExponent;
  return shift >= 0
    ? (numerator * 10n ** BigInt(shift)) % denominator === 0n
    : numerator % (denominator * 10n ** BigInt(-shift)) === 0n;
}

function copyJson(value: unknown, location: string): unknown {
  const active = new Set<object>();
  function visit(current: unknown): void {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || active.has(current)) throw new Error(`${location}: expected an acyclic JSON value`);
    if (!Array.isArray(current) && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) throw new Error(`${location}: expected a JSON object`);
    active.add(current);
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) throw new Error(`${location}: expected an acyclic JSON value`);
        visit(current[index]);
      }
    } else {
      for (const child of Object.values(current)) visit(child);
    }
    active.delete(current);
  }
  visit(value);
  return JSON.parse(JSON.stringify(value)) as unknown;
}

interface SchemaFeatures {
  dynamicRefs: { value: unknown; location: string }[];
  rootDynamicAnchor: unknown;
  hasRef: boolean;
  hasEmbeddedResource: boolean;
}

function checkDialects(schema: unknown, location: string, features: SchemaFeatures, nested = false): void {
  if (typeof schema === 'boolean' || !schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const object = schema as Record<string, unknown>;
  if (object.$schema !== undefined && !isSupportedSchemaDialect(object.$schema)) {
    throw new Error(`${location}/$schema: unsupported JSON Schema dialect ${JSON.stringify(object.$schema)}`);
  }
  if (object.$schema !== undefined) object.$schema = dialect;
  if (nested && object.$id !== undefined) features.hasEmbeddedResource = true;
  if (object.$ref !== undefined) features.hasRef = true;
  if (object.$dynamicAnchor !== undefined) {
    if (nested) throw new Error(`${location}/$dynamicAnchor: nested dynamic anchors are unsupported`);
    features.rootDynamicAnchor = object.$dynamicAnchor;
  }
  if (object.$dynamicRef !== undefined) features.dynamicRefs.push({ value: object.$dynamicRef, location: `${location}/$dynamicRef` });
  if (object.$vocabulary !== undefined) throw new Error(`${location}/$vocabulary: custom vocabularies are unsupported`);
  for (const [keyword, value] of Object.entries(object)) {
    const pointer = `${location}/${keyword.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    if (schemaValues.has(keyword)) checkDialects(value, pointer, features, true);
    if (schemaArrays.has(keyword) && Array.isArray(value)) value.forEach((item, index) => checkDialects(item, `${pointer}/${index}`, features, true));
    if (schemaMaps.has(keyword) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, child] of Object.entries(value)) checkDialects(child, `${pointer}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`, features, true);
    }
  }
}

function checkSchema(schema: unknown, location: string, hasResources: boolean): void {
  const features: SchemaFeatures = { dynamicRefs: [], rootDynamicAnchor: undefined, hasRef: false, hasEmbeddedResource: false };
  checkDialects(schema, location, features);
  for (const ref of features.dynamicRefs) {
    // Ajv falls back to the compiled schema root instead of resolving the static
    // target. Only use it when that root is necessarily the dynamic target.
    if (typeof ref.value !== 'string' || typeof features.rootDynamicAnchor !== 'string' ||
        ref.value !== `#${features.rootDynamicAnchor}` || !/^[A-Za-z_][-A-Za-z0-9._]*$/.test(features.rootDynamicAnchor) ||
        features.hasRef || features.hasEmbeddedResource || hasResources) {
      throw new Error(`${ref.location}: unsupported $dynamicRef target or resource scope`);
    }
  }
}

/** Compile JSON Schema 2020-12 into a self-contained JavaScript validator expression. */
export function compileStandaloneValidator(schema: unknown, options: StandaloneValidatorOptions = {}): string {
  const root = copyJson(schema, '#');
  checkSchema(root, '#', (options.resources?.length ?? 0) > 0);
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    strictSchema: true,
    validateFormats: options.assertFormats ?? false,
    ownProperties: true,
    coerceTypes: false,
    useDefaults: false,
    removeAdditional: false,
    code: { source: true },
  });
  // Ajv resolves anchors while indexing schemas, but does not register the
  // annotation keyword for strict schema compilation.
  ajv.addKeyword({ keyword: '$anchor', schemaType: 'string' });
  ajv.removeKeyword('multipleOf');
  ajv.addKeyword({
    keyword: 'multipleOf',
    type: 'number',
    schemaType: 'number',
    code(context) {
      const helper = context.gen.scopeValue('func', { ref: exactMultipleOf, code: new _Code(exactMultipleOf.toString()) });
      context.fail(_`!${helper}(${context.data}, ${context.schemaCode})`);
    },
  });
  addFormats(ajv);
  try {
    for (const resource of options.resources ?? []) {
      if (typeof resource.id !== 'string' || !resource.id) throw new Error('resource id must be a non-empty string');
      const resourceSchema = copyJson(resource.schema, `resource ${resource.id}`);
      checkSchema(resourceSchema, `resource ${resource.id}`, true);
      ajv.addSchema(resourceSchema as object | boolean, resource.id);
    }
    if (options.rootId !== undefined && (typeof options.rootId !== 'string' || !options.rootId)) throw new Error('rootId must be a non-empty string');
    let validate;
    if (options.rootId !== undefined) {
      ajv.addSchema(root as object | boolean, options.rootId);
      validate = ajv.getSchema(options.rootId);
      if (!validate) throw new Error(`cannot resolve rootId ${JSON.stringify(options.rootId)}`);
    } else {
      validate = ajv.compile(root as object | boolean);
    }
    const equality = `(function equalJson(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) return left.length === right.length && left.every((item, index) => equalJson(item, right[index]));
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.prototype.hasOwnProperty.call(right, key) && equalJson(left[key], right[key]));
})`;
    const source = standaloneCode(ajv, validate).replaceAll('require("ajv/dist/runtime/equal").default', equality);
    const localRequire = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);
    const resolveDir = dirname(localRequire.resolve('ajv/package.json'));
    const result = buildSync({
      stdin: { contents: source, resolveDir, sourcefile: 'validator.js' },
      bundle: true,
      alias: { ajv: resolveDir, 'ajv-formats': dirname(localRequire.resolve('ajv-formats/package.json')) },
      minifyWhitespace: true,
      write: false,
      platform: 'browser',
      format: 'iife',
      globalName: 'standaloneValidator',
      target: 'es2022',
      logLevel: 'silent',
    });
    return `(() => {\n${result.outputFiles[0].text}\nreturn standaloneValidator;\n})()`;
  } catch (error) {
    throw new Error(`Cannot compile standalone JSON Schema validator: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
