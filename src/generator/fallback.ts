import { compileStandaloneValidator, type StandaloneValidatorOptions } from "./validation/index.js";

const schemaMaps = new Set([
  "$defs",
  "definitions",
  "properties",
  "patternProperties",
  "dependentSchemas",
]);
const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const schemaValues = new Set([
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "patternProperties",
  "items",
  "contains",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
]);
const fallbackKeywords = new Set([
  "unevaluatedProperties",
  "unevaluatedItems",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
  "propertyNames",
  "not",
  "contains",
  "minContains",
  "maxContains",
  "uniqueItems",
  "multipleOf",
  "oneOf",
  "pattern",
]);
const openApiAnnotations = new Set([
  "example",
  "externalDocs",
  "xml",
  "discriminator",
  "$anchor",
  "$dynamicAnchor",
]);
const openApiFormats = new Set(["binary", "byte", "password", "int32", "int64", "float", "double"]);

type SchemaObject = Record<string, unknown>;
type ResolvedReference = { canonical: string; uri: string; value: unknown };

function isObject(value: unknown): value is SchemaObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function structuredValue(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function needsStandaloneValidator(
  schema: unknown,
  uri: string,
  resolve: (ref: string, uri: string) => ResolvedReference,
  visited: Set<string>,
  assertFormats: boolean,
): boolean {
  if (!isObject(schema)) return false;
  if (assertFormats && typeof schema.format === "string" && !openApiFormats.has(schema.format)) return true;
  if (structuredValue(schema.const) || (Array.isArray(schema.enum) && schema.enum.some(structuredValue))) return true;
  if (Object.keys(schema).some((key) => fallbackKeywords.has(key))) return true;
  if (typeof schema.$ref === "string") {
    const target = resolve(schema.$ref, uri);
    if (!visited.has(target.canonical)) {
      visited.add(target.canonical);
      if (needsStandaloneValidator(target.value, target.uri, resolve, visited, assertFormats)) return true;
    }
  }
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isObject(value)) {
      if (Object.values(value).some((child) => needsStandaloneValidator(child, uri, resolve, visited, assertFormats))) return true;
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      if (value.some((child) => needsStandaloneValidator(child, uri, resolve, visited, assertFormats))) return true;
    } else if (schemaValues.has(key) && needsStandaloneValidator(value, uri, resolve, visited, assertFormats)) return true;
  }
  return false;
}

function transformSchema(
  schema: unknown,
  uri: string,
  mode: "native" | "validator",
  state: {
    resolve: (ref: string, uri: string) => ResolvedReference;
    references: Map<string, string>;
    definitions: Record<string, unknown>;
    assertFormats: boolean;
  },
): unknown {
  if (!isObject(schema)) return schema;
  if (
    mode === "validator" &&
    ("$id" in schema ||
      "$dynamicRef" in schema ||
      "$vocabulary" in schema)
  ) {
    throw new Error(
      "Schema resource identifiers, dynamic references and custom vocabularies are not supported by the standalone fallback",
    );
  }
  const result: SchemaObject = Object.create(null);
  for (const key of Object.keys(schema).sort()) {
    const value = schema[key];
    if (mode === "native" && ((key === "const" && structuredValue(value)) || (key === "enum" && Array.isArray(value) && value.some(structuredValue)))) continue;
    if (mode === "native" && key === "additionalProperties" && schema.patternProperties !== undefined) continue;
    if (mode === "validator" && state.assertFormats && key === "format" && typeof value === "string" && openApiFormats.has(value)) continue;
    if (mode === "native" && key === "oneOf" && Array.isArray(value)) {
      const branches = value.map(item => transformSchema(item, uri, mode, state));
      if (schema.anyOf === undefined) result.anyOf = branches;
      else if (result.allOf === undefined || Array.isArray(result.allOf)) result.allOf = [...(result.allOf ?? []), { anyOf: branches }];
      else result.oneOf = branches;
      continue;
    }
    if (mode === "validator" && (
      ((key === "then" || key === "else") && schema.if === undefined) ||
      (key === "if" && schema.then === undefined && schema.else === undefined) ||
      ((key === "minContains" || key === "maxContains") && schema.contains === undefined)
    )) continue;
    if (fallbackKeywords.has(key)) {
      if (mode === "native") continue;
    }
    if (
      mode === "validator" &&
      (openApiAnnotations.has(key) || key.startsWith("x-"))
    )
      continue;
    if (key === "$ref" && mode === "validator" && typeof value === "string") {
      const target = state.resolve(value, uri);
      let name = state.references.get(target.canonical);
      if (!name) {
        name = `reference${state.references.size}`;
        state.references.set(target.canonical, name);
        state.definitions[name] = transformSchema(
          target.value,
          target.uri,
          mode,
          state,
        );
      }
      result[key] = `#/$defs/${name}`;
    } else if (schemaMaps.has(key) && isObject(value)) {
      const mapped: SchemaObject = Object.create(null);
      for (const name of Object.keys(value).sort())
        mapped[name] = transformSchema(value[name], uri, mode, state);
      result[key] = mapped;
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      result[key] = value.map((item) =>
        transformSchema(item, uri, mode, state),
      );
    } else if (schemaValues.has(key)) {
      result[key] = transformSchema(value, uri, mode, state);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function prepareStandaloneFallback(
  schema: unknown,
  uri: string,
  resolve: (ref: string, uri: string) => ResolvedReference,
  options: { assertFormats?: boolean; compileValidator?: (schema: unknown, options: StandaloneValidatorOptions) => string } = {},
): { nativeSchema: unknown; validator: string } | undefined {
  if (!needsStandaloneValidator(schema, uri, resolve, new Set(), options.assertFormats ?? false)) return undefined;
  const state = {
    resolve,
    references: new Map<string, string>(),
    definitions: Object.create(null) as Record<string, unknown>,
    assertFormats: options.assertFormats ?? false,
  };
  const nativeSchema = transformSchema(schema, uri, "native", state);
  const validatorSchema = transformSchema(schema, uri, "validator", state);
  const bundledSchema = { $defs: state.definitions, allOf: [validatorSchema] };
  const compileValidator = options.compileValidator ?? compileStandaloneValidator;
  return { nativeSchema, validator: compileValidator(bundledSchema, { assertFormats: state.assertFormats }) };
}
