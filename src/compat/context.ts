import { compileCompatibilitySchema, schemaComplexity } from './schema.js';
import { makePredicate } from './predicate.js';
import { CodeMeta } from './index.js';
import { isBinaryMediaType } from '../runtime/media.js';
import { isReservedAlias } from '../runtime/aliases.js';
import { inferSchemaType } from '../generator/schema/type.js';
import { buildCompatibilitySecurity } from './security.js';
import { isSupportedSchemaDialect } from '../generator/dialect.js';
import type { CodeMetaData, EndpointDefinitionWithRefs, SchemaObject, TemplateContext, TemplateContextOptions } from './index.js';

type ObjectMap = Record<string, any>;
type Endpoint = EndpointDefinitionWithRefs & { method: string; path: string; response: string; parameters: ObjectMap[]; errors: ObjectMap[] };
const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const object = (value: unknown): value is ObjectMap => !!value && typeof value === 'object' && !Array.isArray(value);
const pointer = (value: string) => encodeURIComponent(value.replace(/~/g, '~0').replace(/\//g, '~1'));
const identifier = (value: string) => {
  const name = value.normalize('NFKD').trim().replace(/[^\w$]+/g, '_') || 'Schema';
  return /^\d/.test(name) ? `_${name}` : name;
};
const reserved = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield implements interface package private protected public static z schemas endpoints makeApi Otsc createApiClient __proto__ constructor toString'.split(' '));

export function validateContextOptions(options: TemplateContextOptions): void {
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'baseUrl' && typeof value === 'string') continue;
    if (key === 'apiClientName' && typeof value === 'string') continue;
    if (key === 'withAlias' && (typeof value === 'boolean' || typeof value === 'function')) continue;
    if (key === 'withDeprecatedEndpoints' && typeof value === 'boolean') continue;
    if (key === 'groupStrategy' && ['none', 'tag', 'method', 'tag-file', 'method-file'].includes(value as string)) continue;
    if (['withDefaultValues', 'withImplicitRequiredProps', 'strictObjects', 'allReadonly', 'withDescription', 'withDocs', 'shouldExportAllSchemas', 'shouldExportAllTypes', 'withAllResponses', 'useMainResponseDescriptionAsEndpointDefinitionFallback', 'willSuppressWarnings', 'exportAllNamedSchemas'].includes(key) && typeof value === 'boolean') continue;
    if (key === 'complexityThreshold' && typeof value === 'number' && Number.isFinite(value) && value >= 0) continue;
    if (key === 'additionalPropertiesDefaultValue' && (typeof value === 'boolean' || object(value))) continue;
    if (key === 'defaultStatusBehavior' && ['spec-compliant', 'auto-correct'].includes(value as string)) continue;
    if (['isMainResponseStatus', 'isErrorStatus', 'isMediaTypeAllowed'].includes(key) && (typeof value === 'string' || typeof value === 'function')) continue;
    if ((key === 'schemaRefiner' || key === 'endpointDefinitionRefiner') && typeof value === 'function') continue;
    throw new Error(`OTSC compatibility: option ${key} is not supported`);
  }
}

export function refineSchemaTree(value: unknown, refiner: TemplateContextOptions['schemaRefiner'], meta?: CodeMetaData): unknown {
  if (!object(value)) return value;
  const refined = refiner ? refiner(value, meta) : value;
  if (!object(refined)) throw new Error('OTSC compatibility: schemaRefiner must return a schema object');
  const output = { ...refined };
  const parent = new CodeMeta(refined, undefined, meta).inherit(meta?.parent);
  const childMeta: CodeMetaData = { parent, referencedBy: parent.meta.referencedBy };
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains']) if (object(output[key])) output[key] = refineSchemaTree(output[key], refiner, childMeta);
  for (const key of ['allOf', 'oneOf', 'anyOf', 'prefixItems']) if (Array.isArray(output[key])) output[key] = output[key].map((entry: unknown) => refineSchemaTree(entry, refiner, childMeta));
  for (const key of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) if (object(output[key])) output[key] = Object.fromEntries(Object.entries(output[key]).map(([name, entry]) => [name, refineSchemaTree(entry, refiner, { ...childMeta, name, isRequired: key === 'properties' && Array.isArray(output.required) && output.required.includes(name) })]));
  return output;
}


function resolveServer(servers: unknown): string | undefined {
  if (servers === undefined) return undefined;
  if (!Array.isArray(servers)) throw new Error('OTSC compatibility: servers must be an array');
  if (!servers.length) return undefined;
  const server = servers[0];
  if (!object(server) || typeof server.url !== 'string') throw new Error('OTSC compatibility: server requires a URL');
  const url = server.url.replace(/\{([^{}]+)\}/g, (_match: string, name: string) => {
    const variable = server.variables?.[name];
    if (!object(variable) || typeof variable.default !== 'string' || (Array.isArray(variable.enum) && !variable.enum.includes(variable.default))) throw new Error(`OTSC compatibility: invalid server variable ${name}`);
    return variable.default;
  });
  if (/[{}]/.test(url)) throw new Error('OTSC compatibility: invalid server URL template');
  return url;
}

export function buildEndpointList(document: object, options: TemplateContextOptions = {}) {
  validateContextOptions(options);
  const root = document as ObjectMap;
  if (!object(root) || typeof root.openapi !== 'string' || !/^3\.[012]\./.test(root.openapi)) throw new Error('OTSC compatibility: synchronous helpers require an OpenAPI 3.0, 3.1 or 3.2 document');
  const dialect = root.openapi.startsWith('3.0.') ? '3.0' : root.openapi.startsWith('3.1.') ? '3.1' : '3.2';
  if (dialect === '3.2' && root.$self !== undefined) throw new Error('OTSC compatibility: OpenAPI $self is not supported by context generation');
  if (root.jsonSchemaDialect !== undefined && !isSupportedSchemaDialect(root.jsonSchemaDialect)) throw new Error(`OTSC compatibility: unsupported JSON Schema dialect ${String(root.jsonSchemaDialect)}`);
  const inspectMedia = (media: unknown, location: string, request = false): void => {
    if (!object(media)) throw new Error(`OTSC compatibility: invalid media object at ${location}`);
    for (const field of ['itemSchema', 'itemEncoding', 'prefixEncoding', ...(!request ? ['encoding'] : [])]) {
      if (media[field] !== undefined) throw new Error(`OTSC compatibility: unsupported media ${field} at ${location}`);
    }
  };
  const isMainResponse = makePredicate(options.isMainResponseStatus, 'status', (status: number) => status >= 200 && status < 300);
  const isErrorResponse = makePredicate(options.isErrorStatus, 'status', (status: number) => status < 200 || status >= 300);
  const isMediaAllowed = makePredicate(options.isMediaTypeAllowed, 'mediaType', (mediaType: string) => mediaType === 'application/json');
  const schemaEntries = object(root.components?.schemas) ? root.components.schemas : {};
  const names = new Map<string, string>();
  const used = new Set(reserved);
  for (const name of Object.keys(schemaEntries)) {
    const base = identifier(name);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    names.set(`#/components/schemas/${pointer(name)}`, candidate);
  }
  function resolve(ref: string): any {
    if (!ref.startsWith('#/')) throw new Error(`OTSC compatibility: synchronous helpers require bundled local references: ${ref}`);
    let value: any = root;
    for (const part of ref.slice(2).split('/')) {
      const key = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!object(value) && !Array.isArray(value) || !Object.hasOwn(value, key)) throw new Error(`OTSC compatibility: reference not found: ${ref}`);
      value = (value as ObjectMap)[key];
    }
    return value;
  }
  function deref(value: any): any {
    const visited = new Set<string>();
    while (object(value) && typeof value.$ref === 'string') {
      if (visited.has(value.$ref)) throw new Error(`OTSC compatibility: non-schema reference cycle: ${value.$ref}`);
      visited.add(value.$ref);
      value = resolve(value.$ref);
    }
    return value;
  }
  const graph = dependencyGraph([...names.keys()], resolve, dialect);
  const sameValueGraph = new Map<string, Set<string>>();
  for (const ref of names.keys()) {
    const dependencies = new Set<string>();
    const visit = (value: unknown): void => {
      if (!object(value)) return;
      if (typeof value.$ref === 'string') {
        dependencies.add(value.$ref);
        if (dialect === '3.0') return;
      }
      for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(value[key])) value[key].forEach(visit);
      for (const key of ['not', 'if', 'then', 'else']) visit(value[key]);
      if (object(value.dependentSchemas)) Object.values(value.dependentSchemas).forEach(visit);
    };
    visit(resolve(ref));
    sameValueGraph.set(ref, dependencies);
  }
  const sameValueCycle = (root: string, current: string, visited = new Set<string>()): boolean => {
    if (visited.has(current)) return false;
    visited.add(current);
    for (const next of sameValueGraph.get(current) ?? []) if (next === root || sameValueCycle(root, next, visited)) return true;
    return false;
  };
  for (const ref of names.keys()) if (sameValueCycle(ref, ref)) throw new Error(`OTSC compatibility: schema ${ref} recursively evaluates the same value`);
  function compile(schema: unknown, dependencies: Set<string>, meta?: CodeMetaData, expanding = new Set<string>(), binaryInput = false): string {
    return compileCompatibilitySchema(refineSchemaTree(schema, options.schemaRefiner, meta), options, { dialect, binaryInput, resolveRef: (ref) => {
      const name = names.get(ref);
      if (!name) throw new Error(`OTSC compatibility: schema reference is not a component schema: ${ref}`);
      const target = resolve(ref);
      const cyclic = graph.deepDependencyGraph[ref]?.has(ref);
      if (binaryInput) {
        if (expanding.has(ref)) throw new Error(`OTSC compatibility: recursive binary schema ${ref} cannot be inlined`);
        return `(${compile(target, dependencies, { name }, new Set([...expanding, ref]), true)})`;
      }
      if (options.complexityThreshold !== undefined && !options.exportAllNamedSchemas && !cyclic && !expanding.has(ref) && schemaComplexity(target) <= options.complexityThreshold) {
        return `(${compile(target, dependencies, { name }, new Set([...expanding, ref]))})`;
      }
      dependencies.add(name);
      return name;
    } });
  }
  const schemas: Record<string, string> = Object.create(null);
  const schemaDependencies = new Map<string, Set<string>>();
  for (const [ref, name] of names) {
    const dependencies = new Set<string>();
    const expression = compile(resolve(ref), dependencies, { name });
    schemas[name] = `z.lazy(() => ${expression})`;
    schemaDependencies.set(name, dependencies);
  }
  const schemaByName = Object.fromEntries([...names].map(([ref, name]) => [name, JSON.stringify(resolve(ref))]));
  const schemasByName: Record<string, string[]> = {};
  for (const [name, schema] of Object.entries(schemaByName)) (schemasByName[schema] ??= []).push(name);
  const endpoints: Endpoint[] = [];
  const aliases = new Set<string>();
  const ignoredFallbackResponse: string[] = [];
  const ignoredGenericError: string[] = [];
  const endpointGroups = new Map<Endpoint, string>();
  const endpointDependencies = new Map<Endpoint, Set<string>>();
  for (const [route, rawItem] of Object.entries(root.paths ?? {})) {
    const item = deref(rawItem);
    if (!object(item)) throw new Error(`OTSC compatibility: invalid path item ${route}`);
    if (item.additionalOperations !== undefined) throw new Error(`OTSC compatibility: unsupported additionalOperations at ${route}`);
    if (dialect !== '3.2' && item.query !== undefined) throw new Error(`OTSC compatibility: QUERY requires OpenAPI 3.2 at ${route}`);
    for (const method of dialect === '3.2' ? [...methods, 'query'] : methods) {
      const operation = item[method];
      if (!object(operation) || (operation.deprecated && !options.withDeprecatedEndpoints)) continue;
      const dependencies = new Set<string>();
      const fallbackAlias = method + route.split(/[^A-Za-z0-9_$]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('');
      const alias = typeof options.withAlias === 'function' ? options.withAlias(route, method, operation) : operation.operationId ?? fallbackAlias;
      if (options.withAlias) {
        if (typeof alias !== 'string' || !alias || isReservedAlias(alias) || aliases.has(alias)) throw new Error(`OTSC compatibility: duplicate or reserved alias ${JSON.stringify(alias)}`);
        aliases.add(alias);
      }
      const endpoint: Endpoint = { method, path: route.replace(/\{([^{}]+)\}/g, (_match, name: string) => `:${name}`), originalPath: route, response: 'z.void()', parameters: [], errors: [] };
      const security = buildCompatibilitySecurity(root, operation, deref);
      if (security !== undefined) endpoint.security = security;
      if (options.baseUrl === undefined) {
        const server = resolveServer(operation.servers ?? item.servers);
        if (server !== undefined) endpoint.server = server;
      }
      if (options.withAlias) endpoint.alias = alias;
      if (operation.description) endpoint.description = operation.description;
      const parameters = new Map<string, any>();
      for (const value of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
        const parameter = deref(value);
        if (!object(parameter)) throw new Error('OTSC compatibility: invalid parameter');
        const name = parameter.in === 'header' && typeof parameter.name === 'string' ? parameter.name.toLowerCase() : parameter.name;
        parameters.set(`${parameter.in}:${name}`, parameter);
      }
      for (const parameter of parameters.values()) {
        if (parameter.in === 'header' && typeof parameter.name === 'string' && ['accept', 'content-type', 'authorization'].includes(parameter.name.toLowerCase())) continue;
        const kind: Record<string, string> = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie' };
        if (!kind[parameter.in]) throw new Error(`OTSC compatibility: unsupported parameter location ${parameter.in}`);
        if (typeof parameter.name !== 'string' || !parameter.name) throw new Error('OTSC compatibility: parameter name must be a non-empty string');
        if (dialect === '3.2') {
          if (parameter.content !== undefined && (!object(parameter.content) || Object.keys(parameter.content).length !== 1 || parameter.schema !== undefined || parameter.style !== undefined || parameter.explode !== undefined || parameter.allowReserved !== undefined)) throw new Error(`OTSC compatibility: invalid content-based parameter ${parameter.name}`);
          const styles: Record<string, string[]> = { path: ['simple', 'label', 'matrix'], query: ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'], header: ['simple'], cookie: ['form', 'cookie'] };
          if (parameter.style !== undefined && !styles[parameter.in].includes(parameter.style)) throw new Error(`OTSC compatibility: unsupported ${parameter.in} style ${JSON.stringify(parameter.style)} for ${parameter.name}`);
          for (const key of ['explode', 'allowReserved', 'required']) if (parameter[key] !== undefined && typeof parameter[key] !== 'boolean') throw new Error(`OTSC compatibility: ${key} must be boolean for parameter ${parameter.name}`);
          if (['spaceDelimited', 'pipeDelimited'].includes(parameter.style) && parameter.explode === true) throw new Error(`OTSC compatibility: ${parameter.style} requires explode=false for parameter ${parameter.name}`);
          if (parameter.in === 'path' && parameter.required !== true) throw new Error(`OTSC compatibility: path parameter ${parameter.name} must be required`);
        }
        const parameterMedia = parameter.content && Object.keys(parameter.content).find(mediaType => {
          const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
          return normalized === 'application/json' || normalized.endsWith('+json') || normalized.startsWith('text/') || normalized === 'application/xml' || normalized.endsWith('+xml') || normalized === 'application/jsonpath';
        });
        if (parameter.content && !parameterMedia) throw new Error(`OTSC compatibility: unsupported parameter media types ${Object.keys(parameter.content).join(', ')}`);
        const media = parameterMedia ? deref(parameter.content[parameterMedia]) : undefined;
        if (parameter.content) for (const [mediaType, value] of Object.entries(parameter.content)) inspectMedia(deref(value), `parameter ${parameter.name} ${mediaType}`);
        const expression = compile(parameter.schema ?? media?.schema ?? {}, dependencies, { name: parameter.name, isRequired: parameter.in === 'path' || !!parameter.required });
        const serialization: ObjectMap = { in: parameter.in, name: parameter.name, required: parameter.in === 'path' || parameter.required === true };
        for (const key of ['style', 'explode', 'allowReserved']) if (parameter[key] !== undefined && (key !== 'allowReserved' || parameter.in === 'query' || dialect === '3.2')) serialization[key] = parameter[key];
        if (dialect === '3.2' && serialization.style === 'deepObject') serialization.explode = true;
        if (parameterMedia) serialization.contentMediaType = parameterMedia;
        endpoint.parameters.push({ name: parameter.name, type: kind[parameter.in], ...(parameter.description ? { description: parameter.description } : {}), serialization, schema: expression + (parameter.in !== 'path' && !parameter.required ? '.optional()' : '') });
      }
      if (operation.requestBody) {
        const body = deref(operation.requestBody);
        const media = Object.keys(body.content ?? {});
        const bodyFormat = (mediaType: string): string | undefined => {
          const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
          if (normalized === 'application/json' || normalized.endsWith('+json')) return 'json';
          if (normalized === 'multipart/form-data') return 'form-data';
          if (normalized === 'application/x-www-form-urlencoded') return 'form-url';
          if (isBinaryMediaType(normalized)) return 'binary';
          if (normalized.startsWith('text/') || normalized === 'application/xml' || normalized.endsWith('+xml')) return 'text';
          if (/^(?:\*|[a-z0-9!#$&^_.+-]+)\/\*$/i.test(normalized)) return 'wildcard';
          return undefined;
        };
        const bodySchemas: string[] = [];
        const requestBodies: ObjectMap[] = [];
        for (const mediaType of media) {
          const mediaValue = deref(body.content[mediaType]);
          inspectMedia(mediaValue, `request ${method.toUpperCase()} ${route} ${mediaType}`, true);
          let format = bodyFormat(mediaType);
          if (!format) throw new Error(`OTSC compatibility: unsupported request media type ${mediaType}`);
          if (format === 'wildcard' && mediaValue.schema !== undefined) {
            const schema = deref(mediaValue.schema);
            if (object(schema) && (schema.type === 'file' || (schema.type === 'string' && schema.format === 'binary'))) format = 'binary';
          }
          if (format !== 'wildcard') endpoint.requestFormat ??= format;
          let bodySchema = compile(mediaValue?.schema ?? {}, dependencies, { isRequired: body.required === true }, new Set(), format === 'binary' || format === 'form-data');
          if (format === 'binary') bodySchema = `z.intersection(z.custom<Blob | ArrayBuffer | Uint8Array>(value => (typeof Blob !== "undefined" && value instanceof Blob) || value instanceof ArrayBuffer || value instanceof Uint8Array), ${bodySchema})`;
          if (format === 'text') bodySchema = `z.intersection(z.string(), ${bodySchema})`;
          const originalEncoding = mediaValue?.encoding;
          const encoding = object(originalEncoding) ? Object.fromEntries(Object.entries(originalEncoding).map(([name, value]) => [name, object(value) ? { ...value } : value])) : originalEncoding;
          if (encoding !== undefined) {
            if (!object(encoding) || !['form-data', 'form-url'].includes(format)) throw new Error(`OTSC compatibility: unsupported encoding for ${mediaType}`);
            for (const [name, value] of Object.entries(encoding)) {
              if (!object(value) || Object.keys(value).some(key => !['contentType', 'explode', 'style'].includes(key)) || (value.contentType !== undefined && (typeof value.contentType !== 'string' || value.contentType.includes(','))) || (value.explode !== undefined && typeof value.explode !== 'boolean')) throw new Error(`OTSC compatibility: unsupported encoding for field ${name}`);
              if (value.style !== undefined && !((format === 'form-url' && ['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'].includes(value.style)) || (format === 'form-data' && value.style === 'form'))) throw new Error(`OTSC compatibility: unsupported style ${JSON.stringify(value.style)} for field ${name} in ${mediaType}`);
              if (['spaceDelimited', 'pipeDelimited'].includes(value.style) && value.explode === true) throw new Error(`OTSC compatibility: field ${name}: ${value.style} requires explode=false`);
              if (value.style === 'deepObject' && dialect !== '3.2' && value.explode !== true) throw new Error(`OTSC compatibility: field ${name}: deepObject requires explode=true in OpenAPI ${dialect}`);
              if (value.style === 'deepObject' && dialect === '3.2') value.explode = true;
            }
          }
          requestBodies.push({ mediaType, schema: bodySchema, required: body.required === true, ...(encoding ? { encoding } : {}) });
          bodySchemas.push(bodySchema);
        }
        if (requestBodies.length) {
          endpoint.requestBodies = requestBodies;
          const uniqueSchemas = [...new Set(bodySchemas)];
          const bodySchema = uniqueSchemas.length === 1 ? uniqueSchemas[0] : `z.union([${uniqueSchemas.join(', ')}])`;
          endpoint.parameters.push({ name: 'body', type: 'Body', schema: bodySchema + (body.required === true ? '' : '.optional()') });
        }
      }
      let hasSuccess = false;
      const successSchemas: string[] = [];
      const runtimeResponses: ObjectMap[] = [];
      const allResponses: ObjectMap[] = [];
      let defaultResponse: ObjectMap | undefined;
      for (const [status, responseValue] of Object.entries(operation.responses ?? {})) {
        if (!/^[1-5](?:\d\d|XX)$/.test(status) && status !== 'default') throw new Error(`OTSC compatibility: invalid response status ${status}`);
        const response = deref(responseValue);
        if (!object(response)) throw new Error(`OTSC compatibility: invalid response ${status}`);
        const content = response.content ?? {};
        const media = Object.keys(content);
        for (const mediaType of media) inspectMedia(deref(content[mediaType]), `response ${method.toUpperCase()} ${route} ${status} ${mediaType}`);
        const allowed = media.filter(isMediaAllowed);
        const bodyless = method === 'head' || status === '204' || status === '205';
        const contracts: ObjectMap[] = [];
        if (!media.length) contracts.push({ statusCode: status, schema: 'z.void()' });
        for (const mediaType of allowed) {
          const mediaValue = deref(content[mediaType]);
          if (!object(mediaValue)) throw new Error(`OTSC compatibility: invalid response media ${mediaType}`);
          const normalized = mediaType.split(';', 1)[0]!.trim().toLowerCase();
          const textMedia = normalized.startsWith('text/') || normalized === 'application/xml' || normalized.endsWith('+xml');
          const target = mediaValue.schema === undefined ? undefined : deref(mediaValue.schema);
          const binary = isBinaryMediaType(mediaType) || (!textMedia && normalized !== 'application/json' && !normalized.endsWith('+json') && object(target) && target.type === 'string' && target.format === 'binary');
          let expression: string;
          if (bodyless) expression = 'z.void()';
          else if (binary) {
            const annotations = new Set(['title', 'description', 'default', 'example', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'externalDocs', 'xml', '$schema']);
            const validateBinary = (schema: unknown): void => {
              if (schema === undefined || schema === true) return;
              if (!object(schema)) throw new Error(`OTSC compatibility: unsupported binary response schema for ${mediaType}`);
              if (typeof schema.$ref === 'string') {
                if (Object.keys(schema).some(key => key !== '$ref' && !annotations.has(key) && !key.startsWith('x-'))) throw new Error(`OTSC compatibility: unsupported binary response reference siblings for ${mediaType}`);
                return validateBinary(deref(schema));
              }
              const keys = Object.keys(schema).filter(key => !annotations.has(key) && !key.startsWith('x-'));
              if (keys.length && !(schema.type === 'string' && schema.format === 'binary' && keys.every(key => key === 'type' || key === 'format'))) throw new Error(`OTSC compatibility: unsupported binary response schema for ${mediaType}`);
            };
            validateBinary(refineSchemaTree(mediaValue.schema, options.schemaRefiner, { isRequired: true }));
            expression = 'z.custom<Uint8Array>(value => value instanceof Uint8Array)';
          } else {
            expression = compile(mediaValue.schema ?? {}, dependencies, { isRequired: true });
            if (textMedia) expression = `z.intersection(z.string(), ${expression})`;
          }
          contracts.push({ statusCode: status, mediaType, schema: expression, ...(binary && !bodyless ? { binary: true } : {}) });
        }
        runtimeResponses.push(...contracts);
        const expressions = [...new Set(contracts.map(contract => contract.schema as string))];
        const expression = expressions.length > 1 ? `z.union([${expressions.join(', ')}])` : expressions[0] ?? 'z.void()';
        const item = { statusCode: status, schema: expression, ...(response.description ? { description: response.description } : {}) };
        if (options.withAllResponses) allResponses.push(item);
        if (status === 'default') { defaultResponse = item; continue; }
        const statuses = status.endsWith('XX') ? Array.from({ length: 100 }, (_, index) => Number(status[0]) * 100 + index) : [Number(status)];
        if (statuses.some(isMainResponse)) {
          successSchemas.push(expression);
          hasSuccess = true;
          if (!endpoint.description && options.useMainResponseDescriptionAsEndpointDefinitionFallback && response.description) endpoint.description = response.description;
        }
        if (statuses.some(value => !isMainResponse(value) && isErrorResponse(value))) endpoint.errors.push({ status: status.endsWith('XX') ? status : Number(status), schema: expression, ...(response.description ? { description: response.description } : {}) });
      }
      const uniqueSuccess = [...new Set(successSchemas)];
      if (uniqueSuccess.length) endpoint.response = uniqueSuccess.length === 1 ? uniqueSuccess[0] : `z.union([${uniqueSuccess.join(', ')}])`;
      if (options.withAllResponses) endpoint.responses = allResponses;
      if (defaultResponse) {
        if (options.defaultStatusBehavior === 'auto-correct') {
          if (hasSuccess) endpoint.errors.push({ status: 'default', schema: defaultResponse.schema, ...(defaultResponse.description ? { description: defaultResponse.description } : {}) });
          else endpoint.response = defaultResponse.schema;
        } else if (hasSuccess) ignoredFallbackResponse.push(String(alias));
        else ignoredGenericError.push(String(alias));
      }
      const originalResponseFields = JSON.stringify([endpoint.response, endpoint.errors, endpoint.responses]);
      const refined = (options.endpointDefinitionRefiner?.(endpoint, operation) ?? endpoint) as Endpoint;
      if (!object(refined) || typeof refined.method !== 'string' || typeof refined.path !== 'string' || typeof refined.response !== 'string' || !Array.isArray(refined.parameters) || !Array.isArray(refined.errors)) throw new Error('OTSC compatibility: endpointDefinitionRefiner returned an invalid endpoint');
      if (JSON.stringify([refined.response, refined.errors, refined.responses]) === originalResponseFields) Object.defineProperty(refined, '__responseContracts', { value: runtimeResponses.filter(contract => contract.statusCode !== 'default' || options.defaultStatusBehavior === 'auto-correct'), configurable: true });
      endpoints.push(refined);
      endpointDependencies.set(refined, dependencies);
      const group = options.groupStrategy?.startsWith('tag') ? (Array.isArray(operation.tags) && operation.tags[0] || 'Default') : method;
      const groupName = identifier(String(group));
      if (['__proto__', 'constructor', 'prototype', '__index', '__common', 'index', 'common'].includes(groupName)) throw new Error(`OTSC compatibility: reserved group name ${groupName}`);
      endpointGroups.set(refined, groupName);
    }
  }
  const refs = [...names.keys()];
  const resolver = { resolveRef: (ref: string) => ({ ref, name: ref.split('/').at(-1), normalized: names.get(ref) ?? identifier(ref.split('/').at(-1) ?? '') }), getSchemaByRef: resolve, resolveSchemaName: (name: string) => { const entry = [...names].find(([, value]) => value === name); return entry ? { ref: entry[0], name, normalized: name } : undefined; } };
  if (!options.willSuppressWarnings && (ignoredFallbackResponse.length || ignoredGenericError.length)) console.warn(`OTSC compatibility: default responses were ignored for ${[...ignoredFallbackResponse, ...ignoredGenericError].join(', ')}`);
  return { endpoints, resolver, zodSchemaByName: schemas, schemaByName, schemasByName, ...graph, issues: { ignoredFallbackResponse, ignoredGenericError }, endpointGroups, endpointDependencies, schemaDependencies };
}

function dependencyGraph(refs: string[], resolve: (ref: string) => SchemaObject, dialect: '3.0' | '3.1' | '3.2') {
  const direct: Record<string, Set<string>> = {};
  for (const ref of refs) {
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!object(value)) return;
      if (typeof value.$ref === 'string') {
        (direct[ref] ??= new Set()).add(value.$ref);
        if (dialect === '3.0') return;
      }
      for (const key of ['items', 'additionalProperties', 'allOf', 'oneOf', 'anyOf', 'not', 'if', 'then', 'else', 'propertyNames', 'contains', 'prefixItems']) walk(value[key]);
      for (const key of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) if (object(value[key])) Object.values(value[key]).forEach(walk);
    };
    walk(resolve(ref));
  }
  const deep: Record<string, Set<string>> = {};
  for (const ref of refs) if (direct[ref]) {
    const seen = deep[ref] = new Set();
    const visit = (dependency: string) => { if (seen.has(dependency)) return; seen.add(dependency); direct[dependency]?.forEach(visit); };
    direct[ref].forEach(visit);
  }
  return { refsDependencyGraph: direct, deepDependencyGraph: deep };
}

export function buildTemplateContext(document: object, options: TemplateContextOptions = {}): TemplateContext {
  const result = buildEndpointList(document, options);
  const groups: TemplateContext['endpointsGroups'] = Object.create(null);
  const context: TemplateContext = { schemas: result.zodSchemaByName, endpoints: result.endpoints, endpointsGroups: groups, types: {}, circularTypeByName: {}, emittedType: {}, options: { ...options, baseUrl: options.baseUrl ?? resolveServer((document as ObjectMap).servers) } };
  for (const name of Object.keys(context.schemas)) {
    const visited = new Set<string>();
    const cyclic = (current: string): boolean => {
      if (visited.has(current)) return false;
      visited.add(current);
      return [...result.schemaDependencies.get(current) ?? []].some(dependency => dependency === name || cyclic(dependency));
    };
    if (cyclic(name)) {
      context.circularTypeByName[name] = true;
      const schema = JSON.parse(result.schemaByName[name]);
      const hasDefault = (value: unknown): boolean => Array.isArray(value) ? value.some(hasDefault) : object(value) && (Object.hasOwn(value, 'default') || Object.values(value).some(hasDefault));
      const type = options.schemaRefiner || options.allReadonly || (options.withDefaultValues !== false && hasDefault(schema))
        ? 'any'
        : inferSchemaType(schema, reference => result.resolver.resolveRef(reference).normalized, { dialect: (document as ObjectMap).openapi.startsWith('3.0.') ? '3.0' : (document as ObjectMap).openapi.startsWith('3.2.') ? '3.2' : '3.1' });
      context.types[name] = `type ${name} = ${type}`;
      context.emittedType[name] = true;
    }
  }
  if (options.shouldExportAllSchemas === false && !options.exportAllNamedSchemas) {
    const required = new Set<string>();
    const visit = (name: string) => { if (required.has(name)) return; required.add(name); result.schemaDependencies.get(name)?.forEach(visit); };
    for (const dependencies of result.endpointDependencies.values()) dependencies.forEach(visit);
    if (options.endpointDefinitionRefiner) Object.keys(context.schemas).forEach(visit);
    for (const name of Object.keys(context.schemas)) if (!required.has(name)) { delete context.schemas[name]; delete context.circularTypeByName[name]; delete context.types[name]; delete context.emittedType[name]; }
  }
  if (options.shouldExportAllTypes) for (const name of Object.keys(context.schemas)) if (!context.circularTypeByName[name]) context.types[name] = `type ${name} = z.infer<typeof ${name}>`;
  if (options.withDocs) for (const [ref, schema] of Object.entries((document as ObjectMap).components?.schemas ?? {})) {
    const resolvedName = result.resolver.resolveRef(`#/components/schemas/${pointer(ref)}`).normalized;
    if (!context.types[resolvedName] || !object(schema)) continue;
    const descriptions: string[] = [];
    const walk = (value: unknown, path: string, seen: Set<object>): void => {
      if (!object(value) || seen.has(value)) return;
      seen.add(value);
      if (typeof value.description === 'string' && value.description.trim()) descriptions.push(`${path ? `${path}: ` : ''}${value.description}`);
      if (object(value.properties)) for (const [key, child] of Object.entries(value.properties)) walk(child, path ? `${path}.${key}` : key, seen);
      if (object(value.items)) walk(value.items, `${path}[]`, seen);
      if (object(value.additionalProperties)) walk(value.additionalProperties, `${path}.*`, seen);
      for (const key of ['allOf', 'oneOf', 'anyOf']) if (Array.isArray(value[key])) value[key].forEach((child: unknown) => walk(child, path, seen));
      seen.delete(value);
    };
    walk(schema, '', new Set());
    if (descriptions.length) context.types[resolvedName] = `/**\n${descriptions.map(description => ` * ${description.replace(/\*\//g, '* /').replace(/\r?\n/g, ' ')}`).join('\n')}\n */\n${context.types[resolvedName]}`;
  }
  if (!options.groupStrategy || options.groupStrategy === 'none') return context;
  const groupDependencies = new Map<string, Set<string>>();
  for (const endpoint of result.endpoints) {
    const name = result.endpointGroups.get(endpoint)!;
    const group = groups[name] ??= { schemas: {}, endpoints: [], types: {} };
    group.endpoints.push(endpoint);
    const dependencies = groupDependencies.get(name) ?? new Set<string>();
    const visit = (dependency: string) => { if (dependencies.has(dependency)) return; dependencies.add(dependency); result.schemaDependencies.get(dependency)?.forEach(visit); };
    result.endpointDependencies.get(endpoint)?.forEach(visit);
    if (options.endpointDefinitionRefiner) Object.keys(context.schemas).forEach(visit);
    groupDependencies.set(name, dependencies);
  }
  if (options.exportAllNamedSchemas) for (const dependencies of groupDependencies.values()) for (const name of Object.keys(context.schemas)) dependencies.add(name);
  const shared = new Set<string>();
  if (options.groupStrategy.endsWith('-file')) {
    const counts = new Map<string, number>();
    for (const dependencies of groupDependencies.values()) for (const name of dependencies) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, count] of counts) if (count > 1) shared.add(name);
    context.commonSchemaNames = shared;
  }
  for (const [name, dependencies] of groupDependencies) {
    const group = groups[name];
    if (options.groupStrategy.endsWith('-file')) group.imports = {};
    for (const dependency of dependencies) {
      if (shared.has(dependency)) group.imports![dependency] = 'common';
      else {
        group.schemas[dependency] = context.schemas[dependency];
        if (context.types[dependency]) group.types[dependency] = context.types[dependency];
      }
    }
  }
  return context;
}
