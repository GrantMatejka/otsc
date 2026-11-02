import { isSupportedSchemaDialect } from '../dialect.js';

/** Options for compiling one OpenAPI Schema Object or JSON Schema. */
export interface CompileSchemaOptions {
  resolveRef?: (reference: string) => string;
  pointer?: string;
  dialect?: '3.0' | '3.1' | '3.2';
  binaryInput?: boolean;
  emitMetadata?: boolean;
}

type SchemaObject = Record<string, unknown>;

const annotations = new Set([
  'title', 'description', 'default', 'examples', 'example', 'deprecated',
  'readOnly', 'writeOnly', 'externalDocs', 'xml', 'discriminator',
  'format', 'contentEncoding', 'contentMediaType', 'contentSchema', '$comment', '$anchor', '$dynamicAnchor', '$schema',
]);
const supported = new Set([
  '$ref', '$defs', 'definitions', 'type', 'nullable', 'enum', 'const',
  'allOf', 'anyOf', 'oneOf', 'properties', 'required', 'additionalProperties',
  'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas',
  'patternProperties', 'propertyNames', 'prefixItems', 'contains', 'minContains', 'maxContains',
]);

const ptr = (base: string, key: string | number): string =>
  `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
const literal = (value: unknown): string => JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const sortedKeys = (value: SchemaObject): string[] => Object.keys(value).sort();
const sortedEntries = (value: SchemaObject): [string, unknown][] => sortedKeys(value).map(key => [key, value[key]]);
const metadataKeys = new Set(['title', 'description', 'default', 'examples', 'example', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema']);

export function compileSchemaMetadata(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  const object = schema as SchemaObject;
  const fields = sortedKeys(object).filter(key => metadataKeys.has(key) || key.startsWith('x-'));
  if (!fields.length) return undefined;
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') return Object.fromEntries(sortedKeys(value as SchemaObject).map(key => [key, canonical((value as SchemaObject)[key])]));
    return value;
  }
  const metadata = Object.fromEntries(fields.map(key => [key, canonical(object[key])]));
  return `JSON.parse(${literal(JSON.stringify(metadata))})`;
}

const equality = `(left: unknown, right: unknown): boolean => { if (left === right) return true; if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false; if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => equal(item, right[index])); const leftObject = left as Record<string, unknown>, rightObject = right as Record<string, unknown>; const keys = Object.keys(leftObject); return keys.length === Object.keys(rightObject).length && keys.every(key => Object.prototype.hasOwnProperty.call(rightObject, key) && equal(leftObject[key], rightObject[key])); }`;
const equals = (left: string, right: string): string => `(() => { const equal = ${equality}; return equal(${left}, ${right}); })()`;

/** Compile a schema to a deterministic Zod Classic source expression. */
export function compileSchema(schema: unknown, options: CompileSchemaOptions = {}): string {
  const dialect = options.dialect ?? '3.1';
  const fail = (location: string, message: string): never => { throw new Error(`${location || '#'}: ${message}`); };
  const active = new Set<object>();

  function json(value: unknown, location: string): string {
    const seen = new Set<object>();
    function visit(item: unknown): void {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (typeof item !== 'object' || seen.has(item as object)) fail(location, 'expected a JSON value');
      seen.add(item as object);
      if (Array.isArray(item)) for (const child of item) visit(child);
      else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail(location, 'expected a JSON object');
        for (const child of Object.values(item as SchemaObject)) visit(child);
      }
      seen.delete(item as object);
    }
    visit(value);
    function canonical(item: unknown): string {
      if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
      if (item !== null && typeof item === 'object') {
        const object = item as SchemaObject;
        return `{${sortedKeys(object).map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
      }
      return JSON.stringify(item);
    }
    return value !== null && typeof value === 'object' ? `JSON.parse(${literal(canonical(value))})` : literal(value);
  }
  function compile(value: unknown, location: string): string {
    if (value === true) return 'z.unknown()';
    if (value === false) return 'z.never()';
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(location, 'expected a schema object or boolean');
    if (active.has(value)) return fail(location, 'cyclic JavaScript schema object; use $ref');
    active.add(value);
    try { return compileObject(value as SchemaObject, location); } finally { active.delete(value); }
  }
  function containsBinaryComposition(value: unknown, seen = new Set<object>()): boolean {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(branch => containsBinaryComposition(branch, seen));
    const schema = value as SchemaObject;
    if (schema.type === 'file' || (schema.format === 'binary' && (schema.type === 'string' || (Array.isArray(schema.type) && schema.type.includes('string'))))) return true;
    for (const keyword of ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']) {
      const child = schema[keyword];
      if (Array.isArray(child) ? child.some(branch => containsBinaryComposition(branch, seen)) : containsBinaryComposition(child, seen)) return true;
    }
    return false;
  }
  function compileObject(schemaObject: SchemaObject, location: string): string {
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(schemaObject, key);
    const at = (key: string): string => ptr(location, key);
    const reference = (): string => {
      if (typeof schemaObject.$ref !== 'string') fail(at('$ref'), 'expected a reference string');
      if (!options.resolveRef) fail(at('$ref'), 'reference resolver is required');
      const resolved = options.resolveRef!(schemaObject.$ref as string);
      if (typeof resolved !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(resolved) || ['true', 'false', 'null', 'undefined', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'let', 'static', 'enum', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'yield'].includes(resolved)) fail(at('$ref'), 'resolver must return a valid reference identifier');
      return resolved;
    };
    if (dialect === '3.0' && has('$ref')) return reference();
    if (schemaObject.$schema !== undefined && !isSupportedSchemaDialect(schemaObject.$schema)) fail(ptr(location, '$schema'), `unsupported JSON Schema dialect ${JSON.stringify(schemaObject.$schema)}`);
    for (const key of sortedKeys(schemaObject)) {
      if (!supported.has(key) && !annotations.has(key) && !key.startsWith('x-')) fail(ptr(location, key), `unsupported schema keyword ${JSON.stringify(key)}`);
    }
    const nonnegative = (key: string): number => {
      const value = schemaObject[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return fail(at(key), 'expected a non-negative safe integer');
      return value;
    };
    const number = (key: string): number => {
      const value = schemaObject[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail(at(key), 'expected a finite number');
      return value;
    };
    for (const key of ['$defs', 'definitions']) if (has(key)) {
      const defs = schemaObject[key];
      if (!defs || typeof defs !== 'object' || Array.isArray(defs)) fail(at(key), 'expected an object');
      for (const [name, definition] of sortedEntries(defs as SchemaObject)) {
        if (typeof definition !== 'boolean' && (!definition || typeof definition !== 'object' || Array.isArray(definition))) fail(ptr(at(key), name), 'expected a schema object or boolean');
      }
    }
    let types: string[] | undefined;
    if (has('type')) {
      types = typeof schemaObject.type === 'string' ? [schemaObject.type] : Array.isArray(schemaObject.type) ? schemaObject.type as string[] : fail(at('type'), 'expected a type name or array of type names');
      if (!types.length || types.some(type => typeof type !== 'string' || !['null', 'boolean', 'object', 'array', 'number', 'integer', 'string', ...(options.binaryInput && schemaObject.type === 'file' ? ['file'] : [])].includes(type)) || new Set(types).size !== types.length) fail(at('type'), 'invalid type');
      if (dialect === '3.0' && Array.isArray(schemaObject.type)) fail(at('type'), 'type arrays are not supported in OpenAPI 3.0');
    }
    if (has('nullable') && (dialect !== '3.0' || typeof schemaObject.nullable !== 'boolean')) fail(at('nullable'), 'nullable is only supported as a boolean in OpenAPI 3.0');
    if (dialect === '3.0' && schemaObject.nullable === true && types && !types.includes('null')) types = [...types, 'null'];

    const binaryType = options.binaryInput === true && !!types && (types.includes('file') || (types.includes('string') && schemaObject.format === 'binary'));
    if (options.binaryInput) {
      for (const keyword of ['allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']) {
        if (has(keyword) && (binaryType || containsBinaryComposition(schemaObject[keyword]))) fail(at(keyword), 'binary schemas in same-value composition require a wire-aware validator');
      }
    }
    if (binaryType) {
      for (const keyword of ['$ref', 'minLength', 'maxLength', 'pattern', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties', 'patternProperties', 'propertyNames', 'dependentRequired', 'dependentSchemas']) {
        if (has(keyword)) fail(at(keyword), `cannot apply ${keyword} to a binary input without a wire-aware validator`);
      }
    }

    const advancedKeywords = ['if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'patternProperties', 'propertyNames', 'prefixItems', 'contains', 'minContains', 'maxContains'];
    if (dialect === '3.0') for (const keyword of advancedKeywords) if (has(keyword)) fail(at(keyword), `unsupported keyword ${JSON.stringify(keyword)} in OpenAPI 3.0`);

    const objectKeys = ['properties', 'required', 'additionalProperties', 'minProperties', 'maxProperties'];
    const arrayKeys = ['items', 'minItems', 'maxItems', 'uniqueItems'];
    const stringKeys = ['minLength', 'maxLength', 'pattern'];
    const numberKeys = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
    const applies = (keys: string[]): boolean => keys.some(has);
    function typed(kind: string): string {
      if (binaryType && (kind === 'string' || kind === 'file')) return `z.custom<Blob | ArrayBuffer | Uint8Array>(value => (typeof Blob !== "undefined" && value instanceof Blob) || (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) || (typeof Uint8Array !== "undefined" && value instanceof Uint8Array))`;
      if (kind === 'null') return 'z.null()';
      if (kind === 'boolean') return 'z.boolean()';
      if (kind === 'number') return 'z.number()';
      if (kind === 'integer') return 'z.number().refine(Number.isInteger)';
      if (kind === 'string') {
        let result = 'z.string()';
        for (const key of ['minLength', 'maxLength']) if (has(key)) {
          const limit = nonnegative(key);
          result += `.refine(value => Array.from(value).length ${key === 'minLength' ? '>=' : '<='} ${limit})`;
        }
        if (has('pattern')) {
          if (typeof schemaObject.pattern !== 'string') fail(at('pattern'), 'expected a string');
          try { new RegExp(schemaObject.pattern as string, 'u'); } catch { fail(at('pattern'), 'invalid regular expression'); }
          result += `.refine(value => new RegExp(${literal(schemaObject.pattern)}, "u").test(value))`;
        }
        return result;
      }
      if (kind === 'array') {
        let result: string;
        const tuple = has('prefixItems');
        if (tuple) {
          if (!Array.isArray(schemaObject.prefixItems) || !schemaObject.prefixItems.length) fail(at('prefixItems'), 'expected a non-empty array of schemas');
          const prefix = (schemaObject.prefixItems as unknown[]).map((item, index) => compile(item, ptr(at('prefixItems'), index)));
          const variants = prefix.map((_item, index) => `z.tuple([${prefix.slice(0, index).join(', ')}])`);
          const rest = has('items') ? compile(schemaObject.items, at('items')) : 'z.unknown()';
          variants.push(`z.tuple([${prefix.join(', ')}], ${rest})`);
          result = `z.union([${variants.join(', ')}])`;
        } else result = `z.array(${has('items') ? compile(schemaObject.items, at('items')) : 'z.unknown()'})`;
        if (has('minItems')) result += tuple ? `.refine(value => value.length >= ${nonnegative('minItems')})` : `.min(${nonnegative('minItems')})`;
        if (has('maxItems')) result += tuple ? `.refine(value => value.length <= ${nonnegative('maxItems')})` : `.max(${nonnegative('maxItems')})`;
        if (has('uniqueItems')) {
          if (typeof schemaObject.uniqueItems !== 'boolean') fail(at('uniqueItems'), 'expected a boolean');
          if (schemaObject.uniqueItems) result += `.refine(value => value.every((item, index) => value.slice(0, index).every(other => !${equals('item', 'other')})))`;
        }
        return result;
      }
      let properties: SchemaObject = {};
      if (has('properties')) {
        if (!schemaObject.properties || typeof schemaObject.properties !== 'object' || Array.isArray(schemaObject.properties)) fail(at('properties'), 'expected an object');
        properties = schemaObject.properties as SchemaObject;
      }
      let required: string[] = [];
      if (has('required')) {
        if (!Array.isArray(schemaObject.required) || schemaObject.required.some(name => typeof name !== 'string') || new Set(schemaObject.required).size !== schemaObject.required.length) fail(at('required'), 'expected an array of unique property names');
        required = schemaObject.required as string[];
      }
      const names = sortedKeys(properties);
      const prototypeName = names.find(name => Object.hasOwn(Object.prototype, name));
      if (prototypeName !== undefined) fail(ptr(at('properties'), prototypeName), 'property name conflicts with Zod object parsing; a wire-preserving schema is not yet available');
      if (required.includes('__proto__')) fail(at('required'), 'required __proto__ cannot be preserved by Zod object parsing');
      const fields = names.map(name => `[${literal(name)}]: ${compile(properties[name], ptr(at('properties'), name))}${required.includes(name) ? '' : '.optional()'}`);
      let result = `z.object({ ${fields.join(', ')} })`;
      if (has('patternProperties') || !has('additionalProperties') || schemaObject.additionalProperties === true) result += '.passthrough()';
      else if (schemaObject.additionalProperties === false) result += '.strict()';
      else result += `.catchall(${compile(schemaObject.additionalProperties, at('additionalProperties'))})`;
      if (required.length) result += `.refine(value => ${literal(required)}.every(key => Object.prototype.hasOwnProperty.call(value, key)))`;
      if (has('minProperties')) result += `.refine(value => Object.keys(value).length >= ${nonnegative('minProperties')})`;
      if (has('maxProperties')) result += `.refine(value => Object.keys(value).length <= ${nonnegative('maxProperties')})`;
      return result;
    }
    const union = (expressions: string[]): string => expressions.length === 0 ? 'z.never()' : expressions.length === 1 ? expressions[0]! : `z.union([${expressions.join(', ')}])`;
    const parts: string[] = [];
    if (types) parts.push(union(types.map(typed)));
    for (const [kind, keys, predicate] of [
      ['object', objectKeys, 'value !== null && typeof value === "object" && !Array.isArray(value)'],
      ['array', arrayKeys, 'Array.isArray(value)'],
      ['string', stringKeys, 'typeof value === "string"'],
    ] as const) {
      if (applies(keys) && (!types || !types.includes(kind))) {
        const check = typed(kind);
        parts.push(`z.unknown().refine(value => !(${predicate}) || ${check}.safeParse(value).success)`);
      }
    }
    const objectPredicate = 'value !== null && typeof value === "object" && !Array.isArray(value)';
    const objectChecks: string[] = [];
    const patterns: { pattern: string; expression: string }[] = [];
    if (has('patternProperties')) {
      const patternProperties = schemaObject.patternProperties;
      if (!patternProperties || typeof patternProperties !== 'object' || Array.isArray(patternProperties)) fail(at('patternProperties'), 'expected an object');
      for (const [pattern, propertySchema] of sortedEntries(patternProperties as SchemaObject)) {
        const patternLocation = ptr(at('patternProperties'), pattern);
        try { new RegExp(pattern, 'u'); } catch { fail(patternLocation, 'invalid regular expression'); }
        patterns.push({ pattern, expression: compile(propertySchema, patternLocation) });
      }
      for (const { pattern, expression } of patterns) {
        objectChecks.push(`Object.entries(value).every(([key, item]) => !new RegExp(${literal(pattern)}, "u").test(key) || ${expression}.safeParse(item).success)`);
      }
      if (has('additionalProperties')) {
        const additional = compile(schemaObject.additionalProperties, at('additionalProperties'));
        const propertyNames = schemaObject.properties && typeof schemaObject.properties === 'object' && !Array.isArray(schemaObject.properties) ? sortedKeys(schemaObject.properties as SchemaObject) : [];
        const matches = patterns.map(({ pattern }) => `new RegExp(${literal(pattern)}, "u").test(key)`).join(' || ') || 'false';
        const declared = propertyNames.length ? `${literal(propertyNames)}.includes(key)` : 'false';
        objectChecks.push(`Object.entries(value).every(([key, item]) => ${declared} || (${matches}) || ${additional}.safeParse(item).success)`);
      }
    }
    if (has('propertyNames')) {
      const expression = compile(schemaObject.propertyNames, at('propertyNames'));
      objectChecks.push(`Object.keys(value).every(key => ${expression}.safeParse(key).success)`);
    }
    if (has('dependentRequired')) {
      const dependencies = schemaObject.dependentRequired;
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail(at('dependentRequired'), 'expected an object');
      for (const [name, required] of sortedEntries(dependencies as SchemaObject)) {
        if (!Array.isArray(required) || required.some(name => typeof name !== 'string') || new Set(required).size !== required.length) fail(ptr(at('dependentRequired'), name), 'expected an array of unique property names');
        objectChecks.push(`(!Object.prototype.hasOwnProperty.call(value, ${literal(name)}) || ${literal(required)}.every(key => Object.prototype.hasOwnProperty.call(value, key)))`);
      }
    }
    if (has('dependentSchemas')) {
      const dependencies = schemaObject.dependentSchemas;
      if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) fail(at('dependentSchemas'), 'expected an object');
      for (const [name, dependency] of sortedEntries(dependencies as SchemaObject)) {
        const expression = compile(dependency, ptr(at('dependentSchemas'), name));
        objectChecks.push(`(!Object.prototype.hasOwnProperty.call(value, ${literal(name)}) || ${expression}.safeParse(value).success)`);
      }
    }
    if (objectChecks.length) parts.push(`z.unknown().refine(value => !(${objectPredicate}) || (${objectChecks.join(' && ')}))`);

    const arrayChecks: string[] = [];
    let prefixLength = 0;
    if (has('prefixItems')) {
      if (!Array.isArray(schemaObject.prefixItems) || !schemaObject.prefixItems.length) fail(at('prefixItems'), 'expected a non-empty array of schemas');
      prefixLength = (schemaObject.prefixItems as unknown[]).length;
      for (const [index, item] of (schemaObject.prefixItems as unknown[]).entries()) {
        const expression = compile(item, ptr(at('prefixItems'), index));
        arrayChecks.push(`(value.length <= ${index} || ${expression}.safeParse(value[${index}]).success)`);
      }
      if (has('items')) {
        const expression = compile(schemaObject.items, at('items'));
        arrayChecks.push(`value.slice(${prefixLength}).every(item => ${expression}.safeParse(item).success)`);
      }
    }
    const minimumContains = has('minContains') ? nonnegative('minContains') : 1;
    const maximumContains = has('maxContains') ? nonnegative('maxContains') : undefined;
    if (has('contains')) {
      const expression = compile(schemaObject.contains, at('contains'));
      const count = `value.filter(item => ${expression}.safeParse(item).success).length`;
      arrayChecks.push(`(${count} >= ${minimumContains}${maximumContains === undefined ? '' : ` && ${count} <= ${maximumContains}`})`);
    }
    if (arrayChecks.length) parts.push(`z.unknown().refine(value => !Array.isArray(value) || (${arrayChecks.join(' && ')}))`);

    if (has('not')) {
      const expression = compile(schemaObject.not, at('not'));
      parts.push(`z.unknown().refine(value => !${expression}.safeParse(value).success)`);
    }
    const condition = has('if') ? compile(schemaObject.if, at('if')) : undefined;
    const consequent = has('then') ? compile(schemaObject.then, at('then')) : undefined;
    const alternative = has('else') ? compile(schemaObject.else, at('else')) : undefined;
    if (condition && (consequent || alternative)) {
      parts.push(`z.unknown().refine(value => ${condition}.safeParse(value).success ? ${consequent ? `${consequent}.safeParse(value).success` : 'true'} : ${alternative ? `${alternative}.safeParse(value).success` : 'true'})`);
    }
    for (const key of numberKeys) if (has(key)) {
      if ((key === 'exclusiveMinimum' || key === 'exclusiveMaximum') && dialect === '3.0') {
        if (typeof schemaObject[key] !== 'boolean') fail(at(key), 'expected a boolean in OpenAPI 3.0');
        continue;
      }
      const limit = number(key);
      if (key === 'multipleOf' && limit <= 0) fail(at(key), 'multipleOf must be positive');
      let test: string;
      if (key === 'multipleOf') test = `(() => { const decimal = (numberValue: number) => { const [mantissa, exponent] = numberValue.toString().toLowerCase().split("e"); const [whole, fraction = ""] = mantissa!.split("."); return [BigInt(whole! + fraction), Number(exponent || 0) - fraction.length] as const; }; const [dividend, dividendExponent] = decimal(value), [divisor, divisorExponent] = decimal(${limit}); const shift = dividendExponent - divisorExponent; return shift >= 0 ? (dividend * 10n ** BigInt(shift)) % divisor === 0n : dividend % (divisor * 10n ** BigInt(-shift)) === 0n; })()`;
      else {
        const exclusive = (key === 'minimum' && dialect === '3.0' && schemaObject.exclusiveMinimum === true) || (key === 'maximum' && dialect === '3.0' && schemaObject.exclusiveMaximum === true);
        const op = key === 'minimum' ? (exclusive ? '>' : '>=') : key === 'maximum' ? (exclusive ? '<' : '<=') : key === 'exclusiveMinimum' ? '>' : '<';
        test = `value ${op} ${limit}`;
      }
      parts.push(`z.unknown().refine(value => typeof value !== "number" || (${test}))`);
    }
    if (dialect === '3.0') for (const key of ['exclusiveMinimum', 'exclusiveMaximum']) if (schemaObject[key] === true && !has(key === 'exclusiveMinimum' ? 'minimum' : 'maximum')) fail(at(key), 'exclusive bound requires the corresponding bound');
    if (has('$ref')) {
      parts.push(reference());
    }
    if (has('const')) {
      const value = json(schemaObject.const, at('const'));
      parts.push(schemaObject.const === null || ['string', 'number', 'boolean'].includes(typeof schemaObject.const) ? `z.literal(${value})` : `z.unknown().refine(value => ${equals('value', value)})`);
    }
    if (has('enum')) {
      if (!Array.isArray(schemaObject.enum)) fail(at('enum'), 'expected an array');
      const values = (schemaObject.enum as unknown[]).map((value, index) => json(value, ptr(at('enum'), index)));
      if (values.length && (schemaObject.enum as unknown[]).every(value => typeof value === 'string') && new Set(schemaObject.enum as string[]).size === values.length) parts.push(`z.enum([${values.join(', ')}])`);
      else if ((schemaObject.enum as unknown[]).every(value => value === null || ['string', 'number', 'boolean'].includes(typeof value))) parts.push(union(values.map(value => `z.literal(${value})`)));
      else parts.push(values.length ? `z.unknown().refine(value => [${values.join(', ')}].some(candidate => ${equals('value', 'candidate')}))` : 'z.never()');
    }
    for (const key of ['allOf', 'anyOf', 'oneOf']) if (has(key)) {
      const branches = schemaObject[key];
      if (!Array.isArray(branches) || !branches.length) fail(at(key), 'expected a non-empty array of schemas');
      const compiled = (branches as unknown[]).map((branch, index) => compile(branch, ptr(at(key), index)));
      if (key === 'allOf') parts.push(...compiled);
      else if (key === 'anyOf') parts.push(union(compiled));
      else {
        const count = compiled.map(branch => `Number(${branch}.safeParse(value).success)`).join(' + ');
        parts.push(`z.unknown().refine(value => (${count}) === 1).pipe(${union(compiled)})`);
      }
    }
    let result: string;
    if (!parts.length) result = 'z.unknown()';
    else if (parts.length === 1) result = parts[0]!;
    else {
      const representation = parts.reduce((left, right) => `z.intersection(${left}, ${right})`);
      const checks = parts.map(part => `${part}.safeParse(value).success`).join(' && ');
      result = `z.unknown().refine(value => ${checks}).pipe(${representation})`;
    }
    if (options.emitMetadata) {
      const metadata = compileSchemaMetadata(schemaObject);
      if (metadata) result += `.meta(${metadata})`;
    }
    return result;
  }
  return compile(schema, options.pointer ?? '#');
}
