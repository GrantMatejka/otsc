import { compileSchema, type CompileSchemaOptions } from '../generator/schema/index.js';
import type { SchemaObject, TemplateContextOptions } from './index.js';

const object = (value: unknown): value is SchemaObject => !!value && typeof value === 'object' && !Array.isArray(value);
const literal = (value: unknown): string => {
  const output = JSON.stringify(value);
  if (output === undefined) throw new Error('OTSC compatibility: default must be JSON serializable');
  return output.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
};

export function schemaComplexity(schema: unknown): number {
  if (!object(schema)) return 0;
  if (typeof schema.$ref === 'string') return 2;
  if (Array.isArray(schema.type)) return 2 + schema.type.reduce((total: number, type: unknown) => total + schemaComplexity({ ...schema, type }), 0);
  if (schema.type === 'null') return 1;
  for (const [key, cost] of [['oneOf', 2], ['anyOf', 3], ['allOf', 2]] as const) if (Array.isArray(schema[key])) return cost + (schema[key] as unknown[]).reduce<number>((total, value) => total + schemaComplexity(value), 0);
  if (!schema.type && !schema.properties && !schema.additionalProperties) return 0;
  if (['string', 'number', 'integer', 'boolean'].includes(String(schema.type))) return 1 + (Array.isArray(schema.enum) ? 1 : 0);
  if (schema.type === 'array') return 1 + schemaComplexity(schema.items);
  if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
    if (schema.additionalProperties) return 1 + schemaComplexity(schema.additionalProperties);
    if (object(schema.properties)) return 2 + Object.values(schema.properties).reduce<number>((total, value) => total + schemaComplexity(value), 0);
    return 1;
  }
  return 0;
}

export function compileCompatibilitySchema(schema: unknown, options: TemplateContextOptions, compilerOptions: CompileSchemaOptions = {}): string {
  const needsWrapping = options.withDefaultValues !== false || options.withDescription === true || options.allReadonly === true;
  const inputText = JSON.stringify(schema) ?? '';
  let tokenPrefix = '__otsc_nested_schema_';
  while (inputText.includes(tokenPrefix)) tokenPrefix = `_${tokenPrefix}`;
  let nextToken = 0;
  function compile(value: unknown): string {
    if (!object(value)) return compileSchema(value, compilerOptions);
    const current = { ...value };
    if (current.type === 'object' || current.properties) {
      if (options.strictObjects && (current.additionalProperties === undefined || current.additionalProperties === true)) current.additionalProperties = false;
      else if (current.additionalProperties === undefined && options.additionalPropertiesDefaultValue !== undefined) current.additionalProperties = options.additionalPropertiesDefaultValue;
    }
    if (options.withImplicitRequiredProps && object(current.properties) && current.required === undefined) current.required = Object.keys(current.properties);
    const substitutions = new Map<string, string>();
    function wrap(child: unknown): unknown {
      if (!object(child) && typeof child !== 'boolean') return child;
      const token = `${tokenPrefix}${nextToken++}__`;
      substitutions.set(token, compile(child));
      return { $ref: `#/${token}` };
    }
    if (needsWrapping) {
      for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains']) if (object(current[key])) current[key] = wrap(current[key]);
      for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) if (Array.isArray(current[key])) current[key] = (current[key] as unknown[]).map(wrap);
      for (const key of ['properties', 'patternProperties', 'dependentSchemas']) if (object(current[key])) current[key] = Object.fromEntries(Object.entries(current[key] as SchemaObject).map(([name, child]) => [name, wrap(child)]));
    } else {
      for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains']) if (object(current[key])) current[key] = applyObjectPolicy(current[key], options);
      for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) if (Array.isArray(current[key])) current[key] = (current[key] as unknown[]).map(child => applyObjectPolicy(child, options));
      for (const key of ['properties', 'patternProperties', 'dependentSchemas']) if (object(current[key])) current[key] = Object.fromEntries(Object.entries(current[key] as SchemaObject).map(([name, child]) => [name, applyObjectPolicy(child, options)]));
    }
    let output = compileSchema(current, { ...compilerOptions, resolveRef: ref => {
      if (ref.startsWith(`#/${tokenPrefix}`)) return ref.slice(2);
      if (!compilerOptions.resolveRef) throw new Error(`OTSC compatibility: reference resolver required for ${ref}`);
      const resolved = compilerOptions.resolveRef(ref);
      if (resolved.startsWith(tokenPrefix)) throw new Error('OTSC compatibility: schema reference conflicts with an internal symbol');
      if (!/^[$A-Z_a-z][$\w]*$/.test(resolved)) {
        const token = `${tokenPrefix}${nextToken++}__`;
        substitutions.set(token, resolved);
        return token;
      }
      return resolved;
    } });
    for (const [token, expression] of substitutions) output = output.replace(new RegExp(`\\b${token}\\b`, 'g'), () => `(${expression})`);
    if (options.withDescription && typeof current.description === 'string' && current.description) output += `.describe(${literal(current.description)})`;
    if (options.allReadonly && (current.type === 'object' || current.type === 'array' || current.properties)) output += '.readonly()';
    if (options.withDefaultValues !== false && current.default !== undefined) output += `.default(${literal(current.default)})`;
    return output;
  }
  return compile(schema);
}

function applyObjectPolicy(value: unknown, options: TemplateContextOptions): unknown {
  if (!object(value)) return value;
  const output = { ...value };
  if (output.type === 'object' || output.properties) {
    if (options.strictObjects && (output.additionalProperties === undefined || output.additionalProperties === true)) output.additionalProperties = false;
    else if (output.additionalProperties === undefined && options.additionalPropertiesDefaultValue !== undefined) output.additionalProperties = options.additionalPropertiesDefaultValue;
  }
  if (options.withImplicitRequiredProps && object(output.properties) && output.required === undefined) output.required = Object.keys(output.properties);
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains']) if (object(output[key])) output[key] = applyObjectPolicy(output[key], options);
  for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) if (Array.isArray(output[key])) output[key] = (output[key] as unknown[]).map(child => applyObjectPolicy(child, options));
  for (const key of ['properties', 'patternProperties', 'dependentSchemas']) if (object(output[key])) output[key] = Object.fromEntries(Object.entries(output[key] as SchemaObject).map(([name, child]) => [name, applyObjectPolicy(child, options)]));
  return output;
}
