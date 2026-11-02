export type ProjectionDirection = 'request' | 'response';
export type OpenAPIDialect = '3.0' | '3.1' | '3.2';
export type ProjectableSchema = boolean | Record<string, unknown>;

export interface ResolvedProjectionReference {
  key: string;
  schema: ProjectableSchema;
}

export interface ProjectionOptions {
  direction: ProjectionDirection;
  dialect: OpenAPIDialect;
  resolveRef?: (reference: string, from: string) => ResolvedProjectionReference;
  rootKey?: string;
  excludedProperties?: 'retain' | 'remove';
}

export interface ProjectionResult {
  schema: ProjectableSchema;
  references: ReadonlyMap<string, ProjectableSchema>;
  resolveRef: (reference: string, from?: string) => ProjectableSchema;
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectionError';
  }
}

type SchemaObject = Record<string, unknown>;
type Flags = Map<string, number>;
const readFlag = 1;
const writeFlag = 2;
const mapKeywords = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
const singleKeywords = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'contains', 'additionalItems', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema'];
const arrayKeywords = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

function isObject(value: unknown): value is SchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchema(value: unknown): value is ProjectableSchema {
  return typeof value === 'boolean' || isObject(value);
}

export function projectSchema(schema: ProjectableSchema, options: ProjectionOptions): ProjectionResult {
  const rootKey = options.rootKey ?? '#';
  const references = new Map<string, ProjectableSchema>();
  const resolved = new Map<string, Map<string, ResolvedProjectionReference>>();
  const contexts = new Map<string, string>();
  const memo = new WeakMap<object, Map<string, ProjectableSchema>>();
  const excludedFlag = options.direction === 'request' ? readFlag : writeFlag;

  function resolve(reference: string, from: string): ResolvedProjectionReference {
    let edges = resolved.get(from);
    if (!edges) {
      edges = new Map();
      resolved.set(from, edges);
    }
    const cached = edges.get(reference);
    if (cached) return cached;
    if (!options.resolveRef) throw new ProjectionError(`No resolver for ${JSON.stringify(reference)} from ${JSON.stringify(from)}`);
    const target = options.resolveRef(reference, from);
    if (!target || typeof target.key !== 'string' || !isSchema(target.schema)) throw new ProjectionError(`Invalid resolution for ${JSON.stringify(reference)} from ${JSON.stringify(from)}`);
    edges.set(reference, target);
    return target;
  }

  function annotations(value: ProjectableSchema, scope: string, visited: Set<object>): number {
    if (!isObject(value) || visited.has(value)) return 0;
    visited.add(value);
    let flags = (value.readOnly === true ? readFlag : 0) | (value.writeOnly === true ? writeFlag : 0);
    if (typeof value.$ref === 'string') {
      const target = resolve(value.$ref, scope);
      const targetFlags = annotations(target.schema, target.key, visited);
      if (options.dialect === '3.0') return targetFlags;
      flags |= targetFlags;
    }
    if (Array.isArray(value.allOf)) for (const branch of value.allOf) if (isSchema(branch)) flags |= annotations(branch, scope, visited);
    for (const keyword of ['anyOf', 'oneOf', 'not', 'if', 'then', 'else']) {
      const branches = Array.isArray(value[keyword]) ? value[keyword] : [value[keyword]];
      if (branches.some(branch => isSchema(branch) && annotations(branch, scope, new Set(visited)) !== 0)) {
        throw new ProjectionError(`Ambiguous ${keyword} annotation in ${JSON.stringify(scope)}`);
      }
    }
    return flags;
  }

  function collect(value: ProjectableSchema, scope: string, flags: Flags, visited: Set<object>): void {
    if (!isObject(value) || visited.has(value)) return;
    visited.add(value);
    if (typeof value.$ref === 'string') {
      const target = resolve(value.$ref, scope);
      collect(target.schema, target.key, flags, visited);
      if (options.dialect === '3.0') return;
    }
    if (isObject(value.properties)) for (const [name, property] of Object.entries(value.properties)) {
      if (isSchema(property)) flags.set(name, (flags.get(name) ?? 0) | annotations(property, scope, new Set()));
    }
    if (Array.isArray(value.allOf)) for (const branch of value.allOf) if (isSchema(branch)) collect(branch, scope, flags, visited);
  }

  function requiredNames(value: ProjectableSchema, scope: string, names: Set<string>, visited: Set<object>): void {
    if (!isObject(value) || visited.has(value)) return;
    visited.add(value);
    if (typeof value.$ref === 'string') {
      const target = resolve(value.$ref, scope);
      requiredNames(target.schema, target.key, names, visited);
      if (options.dialect === '3.0') return;
    }
    if (Array.isArray(value.required)) for (const name of value.required) if (typeof name === 'string') names.add(name);
    if (Array.isArray(value.allOf)) for (const branch of value.allOf) if (isSchema(branch)) requiredNames(branch, scope, names, visited);
  }

  function signature(flags: Flags): string {
    return JSON.stringify([...flags].filter(([, value]) => (value & excludedFlag) !== 0).map(([name]) => name).sort());
  }

  function project(value: ProjectableSchema, scope: string, inherited: Flags = new Map(), inheritedRequired: Set<string> = new Set()): ProjectableSchema {
    if (typeof value === 'boolean') return value;
    const flags = new Map(inherited);
    collect(value, scope, flags, new Set());
    const required = new Set(inheritedRequired);
    requiredNames(value, scope, required, new Set());
    for (const keyword of ['anyOf', 'oneOf']) {
      if (!Array.isArray(value[keyword])) continue;
      for (const branch of value[keyword]) {
        if (!isSchema(branch)) continue;
        const branchFlags: Flags = new Map();
        collect(branch, scope, branchFlags, new Set());
        if ([...branchFlags].some(([name, flag]) => required.has(name) && (flag & excludedFlag) !== 0)) {
          throw new ProjectionError(`Ambiguous ${keyword} annotation for a separately required property in ${JSON.stringify(scope)}`);
        }
      }
    }
    if (!(options.dialect === '3.0' && typeof value.$ref === 'string')) {
      for (const keyword of ['if', 'then', 'else']) {
        const branch = value[keyword];
        if (!isSchema(branch)) continue;
        const branchFlags: Flags = new Map();
        collect(branch, scope, branchFlags, new Set());
        if ([...branchFlags].some(([property, flag]) => required.has(property) && (flag & excludedFlag) !== 0 && ((flags.get(property) ?? 0) & excludedFlag) === 0)) {
          throw new ProjectionError(`Ambiguous ${keyword} annotation for a separately required property in ${JSON.stringify(scope)}`);
        }
      }
    }
    if (isObject(value.dependentSchemas)) {
      for (const [name, branch] of Object.entries(value.dependentSchemas)) {
        if (!isSchema(branch)) continue;
        const branchFlags: Flags = new Map();
        collect(branch, scope, branchFlags, new Set());
        if ([...branchFlags].some(([property, flag]) => required.has(property) && (flag & excludedFlag) !== 0 && ((flags.get(property) ?? 0) & excludedFlag) === 0)) {
          throw new ProjectionError(`Ambiguous dependentSchemas annotation for a separately required property ${JSON.stringify(name)} in ${JSON.stringify(scope)}`);
        }
      }
    }
    const context = JSON.stringify([signature(flags), [...required].sort()]);
    const memoKey = JSON.stringify([scope, context]);
    const cached = memo.get(value)?.get(memoKey);
    if (cached !== undefined) return cached;
    const output: SchemaObject = { ...value };
    let variants = memo.get(value);
    if (!variants) { variants = new Map(); memo.set(value, variants); }
    variants.set(memoKey, output);

    if (typeof value.$ref === 'string') {
      const target = resolve(value.$ref, scope);
      const previous = contexts.get(target.key);
      if (previous !== undefined && previous !== context) throw new ProjectionError(`Reference ${JSON.stringify(target.key)} requires incompatible projection contexts`);
      contexts.set(target.key, context);
      if (!references.has(target.key)) {
        references.set(target.key, true);
        references.set(target.key, project(target.schema, target.key, flags, required));
      }
      if (options.dialect === '3.0') return output;
    }
    if (Array.isArray(value.required)) output.required = value.required.filter(name => typeof name !== 'string' || ((flags.get(name) ?? 0) & excludedFlag) === 0);
    for (const keyword of mapKeywords) {
      const entries = value[keyword];
      if (!isObject(entries)) continue;
      const projected: SchemaObject = {};
      for (const [name, child] of Object.entries(entries)) {
        if (keyword === 'properties' && options.excludedProperties === 'remove' && ((flags.get(name) ?? 0) & excludedFlag) !== 0) continue;
        Object.defineProperty(projected, name, { value: isSchema(child) ? project(child, scope, keyword === 'dependentSchemas' ? flags : new Map(), keyword === 'dependentSchemas' ? required : new Set()) : child, enumerable: true, writable: true, configurable: true });
      }
      output[keyword] = projected;
    }
    for (const keyword of singleKeywords) {
      const child = value[keyword];
      if (isSchema(child)) output[keyword] = project(child, scope);
      else if (keyword === 'items' && Array.isArray(child)) output[keyword] = child.map(item => isSchema(item) ? project(item, scope) : item);
    }
    for (const keyword of arrayKeywords) {
      const children = value[keyword];
      if (Array.isArray(children)) output[keyword] = children.map(child => isSchema(child) ? project(child, scope, keyword === 'allOf' || keyword === 'anyOf' || keyword === 'oneOf' ? flags : new Map(), keyword === 'allOf' || keyword === 'anyOf' || keyword === 'oneOf' ? required : new Set()) : child);
    }
    return output;
  }

  const projected = project(schema, rootKey);
  return {
    schema: projected,
    references,
    resolveRef(reference, from = rootKey) {
      const target = resolved.get(from)?.get(reference);
      if (!target || !references.has(target.key)) throw new ProjectionError(`Reference ${JSON.stringify(reference)} from ${JSON.stringify(from)} was not projected`);
      return references.get(target.key)!;
    },
  };
}
