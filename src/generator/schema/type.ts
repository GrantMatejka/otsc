type Schema = Record<string, unknown>;

function isObject(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function literalType(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'unknown';
  if (Array.isArray(value)) return `[${value.map(literalType).join(', ')}]`;
  if (isObject(value)) return `{ ${Object.keys(value).sort().map(key => `${JSON.stringify(key)}: ${literalType(value[key])}`).join('; ')} }`;
  return 'unknown';
}

/** Produce a conservative TypeScript representation for recursive schema declarations. */
export function inferSchemaType(
  schema: unknown,
  resolveRef: (reference: string) => string | undefined,
  options: { dialect: '3.0' | '3.1' | '3.2'; binaryInput?: boolean },
): string {
  function infer(value: unknown, contextTypes: unknown[] = []): string {
    if (value === true) return 'unknown';
    if (value === false) return 'never';
    if (!isObject(value)) return 'unknown';
    if (options.dialect === '3.0' && typeof value.$ref === 'string') return resolveRef(value.$ref) ?? 'unknown';
    const schemaObject = value;
    const parts: string[] = [];
    const types = typeof value.type === 'string' ? [value.type] : Array.isArray(value.type) ? value.type : [];
    const nullable = options.dialect === '3.0' && value.nullable === true && types.length > 0;
    const effectiveTypes = types.length ? [...types, ...(nullable && !types.includes('null') ? ['null'] : [])] : contextTypes;
    function typeFor(type: unknown): string {
      if (type === 'null') return 'null';
      if (type === 'boolean') return 'boolean';
      if (type === 'number' || type === 'integer') return 'number';
      if (type === 'file' && options.binaryInput) return 'Blob | ArrayBuffer | Uint8Array';
      if (type === 'string') return options.binaryInput && schemaObject.format === 'binary' ? 'Blob | ArrayBuffer | Uint8Array' : 'string';
      if (type === 'array') {
        const prefix = Array.isArray(schemaObject.prefixItems) ? schemaObject.prefixItems.map(item => infer(item)) : [];
        const rest = schemaObject.items === undefined ? 'unknown' : infer(schemaObject.items);
        const min = typeof schemaObject.minItems === 'number' && Number.isSafeInteger(schemaObject.minItems) && schemaObject.minItems >= 0 && schemaObject.minItems <= 16 ? schemaObject.minItems : 0;
        const max = typeof schemaObject.maxItems === 'number' && Number.isSafeInteger(schemaObject.maxItems) && schemaObject.maxItems >= 0 && schemaObject.maxItems <= 16 ? schemaObject.maxItems : undefined;
        if (max !== undefined && min > max) return 'never';
        if (!prefix.length && min === 0 && max === undefined) return `(${rest})[]`;
        const variants: string[] = [];
        const tuple = (items: string[]) => `[${items.join(', ')}]`;
        for (let length = min; length < prefix.length && (max === undefined || length <= max); length++) variants.push(tuple(prefix.slice(0, length)));
        if (max !== undefined) {
          for (let length = Math.max(min, prefix.length); length <= max; length++) variants.push(tuple([...prefix, ...Array(length - prefix.length).fill(rest)]));
        } else {
          const requiredRest = Array(Math.max(0, min - prefix.length)).fill(rest);
          variants.push(tuple([...prefix, ...requiredRest, `...(${rest})[]`]));
        }
        return variants.length ? `(${variants.join(' | ')})` : 'never';
      }
      if (type === 'object') {
        const properties = isObject(schemaObject.properties) ? schemaObject.properties : {};
        const required = new Set(Array.isArray(schemaObject.required) ? schemaObject.required.filter((name): name is string => typeof name === 'string') : []);
        const names = [...new Set([...Object.keys(properties), ...required])].sort();
        const patterns = isObject(schemaObject.patternProperties) ? Object.entries(schemaObject.patternProperties) : [];
        const propertyTypes = new Map(names.map(name => {
          const declared = Object.hasOwn(properties, name);
          const matched = patterns.filter(([pattern]) => {
            try { return new RegExp(pattern, 'u').test(name); } catch { return false; }
          });
          const constraints = [
            ...(declared ? [infer(properties[name])] : []),
            ...matched.map(([, pattern]) => infer(pattern)),
            ...(!declared && !matched.length && schemaObject.additionalProperties !== undefined ? [infer(schemaObject.additionalProperties)] : []),
          ];
          return [name, constraints.length ? constraints.map(type => `(${type})`).join(' & ') : 'unknown'];
        }));
        const fields = names.map(name => `${JSON.stringify(name)}${required.has(name) ? '' : '?'}: ${propertyTypes.get(name)}`);
        if (schemaObject.additionalProperties !== false || isObject(schemaObject.patternProperties)) {
          const indexTypes = [
            ...(schemaObject.additionalProperties === false ? [] : [schemaObject.additionalProperties === undefined ? 'unknown' : infer(schemaObject.additionalProperties)]),
            ...(isObject(schemaObject.patternProperties) ? Object.values(schemaObject.patternProperties).map(item => infer(item)) : []),
            ...names.map(name => propertyTypes.get(name)!),
            ...(names.some(name => !required.has(name)) ? ['undefined'] : []),
          ];
          if (indexTypes.length) fields.push(`[key: string]: ${indexTypes.includes('unknown') ? 'unknown' : [...new Set(indexTypes)].map(item => `(${item})`).join(' | ')}`);
        }
        return `{ ${fields.join('; ')} }`;
      }
      return 'unknown';
    }
    if (types.length) parts.push(`(${effectiveTypes.map(typeFor).join(' | ')})`);
    else if (effectiveTypes.length && ['properties', 'required', 'additionalProperties', 'patternProperties', 'items', 'prefixItems'].some(key => Object.hasOwn(value, key))) {
      parts.push(`(${effectiveTypes.map(typeFor).join(' | ')})`);
    }
    if (typeof value.$ref === 'string') parts.push(resolveRef(value.$ref) ?? 'unknown');
    if (Object.hasOwn(value, 'const')) parts.push(literalType(value.const));
    if (Array.isArray(value.enum)) {
      const literals = value.enum.map(literalType);
      parts.push(literals.length ? `(${literals.join(' | ')})` : 'never');
    }
    if (Array.isArray(value.allOf) && value.allOf.length) parts.push(...value.allOf.map(branch => infer(branch, effectiveTypes)));
    for (const key of ['anyOf', 'oneOf']) {
      const branches = value[key];
      if (Array.isArray(branches) && branches.length) parts.push(`(${branches.map(branch => infer(branch, effectiveTypes)).join(' | ')})`);
    }
    return parts.length ? parts.map(part => `(${part})`).join(' & ') : 'unknown';
  }
  return infer(schema);
}
