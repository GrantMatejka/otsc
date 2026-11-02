import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import path from 'node:path';
import Handlebars from 'handlebars';
import { format, type Options as PrettierOptions } from 'prettier';
import { generateClient } from '../generator/index.js';
import { compileCompatibilitySchema, schemaComplexity } from './schema.js';
import { buildEndpointList, buildTemplateContext, refineSchemaTree, validateContextOptions } from './context.js';
import { groupClientName, renderCommon, renderGrouped, renderSingle } from './render.js';
import { filterDeprecated } from './filter.js';
import { bundleContextDocument } from './bundle.js';

export type SchemaObject = Record<string, unknown>;
export type TemplateContextGroupStrategy = 'none' | 'tag' | 'method' | 'tag-file' | 'method-file';
export interface CodeMetaData { isRequired?: boolean; name?: string; parent?: CodeMeta; referencedBy?: CodeMeta[] }
export interface ConversionTypeContext {
  resolver: { resolveRef(ref: string): { normalized: string }; getSchemaByRef(ref: string): SchemaObject };
  zodSchemaByName: Record<string, string>;
  schemaByName: Record<string, string>;
  schemasByName?: Record<string, string[]>;
}
export interface EndpointDefinitionWithRefs {
  method: string;
  path: string;
  alias?: string;
  description?: string;
  requestFormat?: string;
  response: string;
  parameters: Array<{ name: string; type?: string; schema: string; description?: string; [key: string]: unknown }>;
  errors: Array<{ status: number | string; schema: string; description?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface TemplateContext {
  schemas: Record<string, string>;
  endpoints: EndpointDefinitionWithRefs[];
  endpointsGroups: Record<string, { schemas: Record<string, string>; endpoints: EndpointDefinitionWithRefs[]; types: Record<string, string>; imports?: Record<string, string> }>;
  types: Record<string, string>;
  circularTypeByName: Record<string, true>;
  emittedType: Record<string, true>;
  commonSchemaNames?: Set<string>;
  options?: TemplateContextOptions;
}
export interface TemplateContextOptions {
  baseUrl?: string;
  withAlias?: boolean | ((path: string, method: string, operation: any) => string);
  apiClientName?: string;
  isMainResponseStatus?: string | ((status: number) => boolean);
  isErrorStatus?: string | ((status: number) => boolean);
  isMediaTypeAllowed?: string | ((mediaType: string) => boolean);
  useMainResponseDescriptionAsEndpointDefinitionFallback?: boolean;
  shouldExportAllSchemas?: boolean;
  shouldExportAllTypes?: boolean;
  withImplicitRequiredProps?: boolean;
  withDefaultValues?: boolean;
  withDeprecatedEndpoints?: boolean;
  withDocs?: boolean;
  groupStrategy?: TemplateContextGroupStrategy;
  complexityThreshold?: number;
  defaultStatusBehavior?: 'spec-compliant' | 'auto-correct';
  willSuppressWarnings?: boolean;
  withDescription?: boolean;
  endpointDefinitionRefiner?: (definition: EndpointDefinitionWithRefs, operation: any) => EndpointDefinitionWithRefs;
  allReadonly?: boolean;
  strictObjects?: boolean;
  additionalPropertiesDefaultValue?: boolean | SchemaObject;
  withAllResponses?: boolean;
  exportAllNamedSchemas?: boolean;
  schemaRefiner?: <Schema extends SchemaObject>(schema: Schema, parentMeta?: CodeMetaData) => Schema;
}
export interface GenerateZodClientFromOpenApiArgs {
  openApiDoc: object | string;
  distPath?: string;
  disableWriteToFile?: boolean;
  templatePath?: string;
  prettierConfig?: PrettierOptions | null;
  options?: TemplateContextOptions;
  handlebars?: ReturnType<typeof getHandlebars>;
}

function unsupported(feature: string): never {
  throw new Error(`OTSC compatibility: ${feature} is not supported by the modern generator`);
}

export function getHandlebars() {
  const instance = Handlebars.create();
  instance.registerHelper('ifeq', function (this: unknown, left: unknown, right: unknown, options: Handlebars.HelperOptions) {
    return left === right ? options.fn(this) : options.inverse(this);
  });
  instance.registerHelper('ifNotEmptyObj', function (this: unknown, value: unknown, options: Handlebars.HelperOptions) {
    return value !== null && typeof value === 'object' && Object.keys(value).length > 0 ? options.fn(this) : options.inverse(this);
  });
  instance.registerHelper('toCamelCase', (input: string) => {
    if (/^[a-z][a-zA-Z0-9]*$/.test(input)) return input;
    return input.split(/[\s_-]/).map((word, index) => index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
  });
  return instance;
}

export async function maybePretty(input: string, options?: PrettierOptions | null): Promise<string> {
  try { return await format(input.trim(), { parser: 'typescript', ...options }); }
  catch { return input; }
}

export class CodeMeta {
  private code?: string;
  ref?: string;
  children: CodeMeta[] = [];
  meta: CodeMetaData & { referencedBy: CodeMeta[] };
  constructor(public schema: SchemaObject, public ctx?: ConversionTypeContext, meta: CodeMetaData = {}) {
    if (typeof schema.$ref === 'string') this.ref = schema.$ref;
    this.meta = { ...meta, referencedBy: [...(meta.referencedBy ?? [])] };
    if (this.ref) this.meta.referencedBy.push(this);
  }
  get codeString(): string {
    if (this.code !== undefined) return this.code;
    if (!this.ref) throw new Error('CodeMeta has no assigned code');
    return this.ctx ? this.ctx.resolver.resolveRef(this.ref).normalized : this.ref;
  }
  get complexity(): number { return schemaComplexity(this.schema); }
  assign(code: string): this { this.code = code; return this; }
  inherit(parent?: CodeMeta): this { if (parent) parent.children.push(this); return this; }
  toString(): string { return this.codeString; }
  toJSON(): string { return this.codeString; }
}

export function getZodSchema({ schema, ctx, meta, options }: { schema: SchemaObject; ctx?: ConversionTypeContext; meta?: CodeMetaData; options?: TemplateContextOptions }): CodeMeta {
  if (!schema) throw new Error('Schema is required');
  const schemaOptions = options ?? {};
  validateContextOptions(schemaOptions);
  const refined = refineSchemaTree(schema, schemaOptions.schemaRefiner, meta) as SchemaObject;
  const result = new CodeMeta(refined, ctx, meta).inherit(meta?.parent);
  if (typeof refined.$ref === 'string') {
    if (!ctx) throw new Error('OTSC compatibility: getZodSchema requires a context for references');
    const ref = refined.$ref;
    const target = ctx.resolver.getSchemaByRef(ref);
    const name = ctx.resolver.resolveRef(ref)?.normalized;
    if (!name) throw new Error(`OTSC compatibility: unresolved reference ${ref}`);
    if (!ctx.zodSchemaByName[name]) {
      if (!target) throw new Error(`OTSC compatibility: unresolved reference ${ref}`);
      ctx.zodSchemaByName[name] = name;
      try { ctx.zodSchemaByName[name] = getZodSchema({ schema: target, ctx, options: schemaOptions, meta: { parent: result, referencedBy: result.meta.referencedBy } }).toString(); }
      catch (error) { delete ctx.zodSchemaByName[name]; throw error; }
    }
    if (Object.keys(refined).length === 1) return result;
  }
  return result.assign(compileCompatibilitySchema(refined, schemaOptions, { resolveRef: ref => {
    if (!ctx) throw new Error(`OTSC compatibility: getZodSchema requires a context for reference ${ref}`);
    const reference = getZodSchema({ schema: { $ref: ref }, ctx, options: schemaOptions, meta: { parent: result, referencedBy: result.meta.referencedBy } });
    return reference.toString();
  } }));
}

export function getOpenApiDependencyGraph(schemaRefs: string[], getSchemaByRef: (ref: string) => SchemaObject) {
  const refsDependencyGraph: Record<string, Set<string>> = {};
  const visited = new Set<string>();
  function visitRef(ref: string): void {
    if (visited.has(ref)) return;
    visited.add(ref);
    const schema = getSchemaByRef(ref);
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object') return;
      const entry = value as SchemaObject;
      if (typeof entry.$ref === 'string') {
        (refsDependencyGraph[ref] ??= new Set()).add(entry.$ref);
        visitRef(entry.$ref);
      }
      for (const key of ['allOf', 'anyOf', 'oneOf', 'items', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains', 'prefixItems']) walk(entry[key]);
      for (const key of ['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']) {
        const children = entry[key];
        if (children && typeof children === 'object' && !Array.isArray(children)) Object.values(children).forEach(walk);
      }
    };
    walk(schema);
  }
  schemaRefs.forEach(visitRef);
  const deepDependencyGraph: Record<string, Set<string>> = {};
  for (const ref of schemaRefs) {
    if (!refsDependencyGraph[ref]) continue;
    const dependencies = deepDependencyGraph[ref] = new Set<string>();
    const walk = (dependency: string): void => {
      if (dependencies.has(dependency)) return;
      dependencies.add(dependency);
      refsDependencyGraph[dependency]?.forEach(walk);
    };
    refsDependencyGraph[ref].forEach(walk);
  }
  return { refsDependencyGraph, deepDependencyGraph };
}

export function getZodClientTemplateContext(document: object, options?: TemplateContextOptions): TemplateContext {
  return buildTemplateContext(document, options);
}
export function getOtscEndpointDefinitionList(document: object, options?: TemplateContextOptions) {
  const { endpointGroups, endpointDependencies, schemaDependencies, ...result } = buildEndpointList(document, options);
  return result;
}

async function loadDocument(input: object | string): Promise<{ document: object; source: object | string }> {
  if (typeof input !== 'string') return { document: input, source: input };
  let content: string;
  let source = input;
  if (/^https?:\/\//i.test(input)) {
    const response = await fetch(input);
    if (!response.ok) throw new Error(`OTSC compatibility: HTTP ${response.status} loading document`);
    content = await response.text();
    source = response.url || input;
  } else content = await readFile(input.startsWith('file:') ? fileURLToPath(input) : input, 'utf8');
  const document = parseYaml(content);
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('OTSC compatibility: expected an OpenAPI document object');
  return { document, source };
}

export async function generateZodClientFromOpenAPI(args: GenerateZodClientFromOpenApiArgs & { options: TemplateContextOptions & { groupStrategy: 'tag-file' | 'method-file' } }): Promise<Record<string, string>>;
export async function generateZodClientFromOpenAPI(args: GenerateZodClientFromOpenApiArgs & { options?: TemplateContextOptions & { groupStrategy?: 'none' | 'tag' | 'method' } }): Promise<string>;
export async function generateZodClientFromOpenAPI(args: GenerateZodClientFromOpenApiArgs): Promise<string | Record<string, string>>;
export async function generateZodClientFromOpenAPI(args: GenerateZodClientFromOpenApiArgs): Promise<string | Record<string, string>> {
  const { openApiDoc, options = {}, distPath, disableWriteToFile, templatePath, handlebars, prettierConfig } = args;
  for (const key of Object.keys(args)) if (!['openApiDoc', 'options', 'distPath', 'disableWriteToFile', 'templatePath', 'handlebars', 'prettierConfig'].includes(key)) unsupported(`argument ${key}`);
  if (!disableWriteToFile && !distPath) throw new Error('OTSC compatibility: distPath is required unless disableWriteToFile is true');
  if (disableWriteToFile && distPath) throw new Error('OTSC compatibility: distPath cannot be combined with disableWriteToFile');
  validateContextOptions(options);
  const clientName = options.apiClientName ?? 'api';
  const forbiddenNames = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield endpoints schemas createApiClient z Otsc OtscOptions makeApi'.split(' '));
  if (!/^[$A-Z_a-z][$\w]*$/.test(clientName) || forbiddenNames.has(clientName)) throw new Error(`OTSC compatibility: invalid or conflicting apiClientName ${JSON.stringify(clientName)}`);
  const { document, source } = await loadDocument(openApiDoc);
  const strategy = options.groupStrategy ?? 'none';
  const contextOptionKeys = new Set(['withDefaultValues', 'withImplicitRequiredProps', 'strictObjects', 'additionalPropertiesDefaultValue', 'allReadonly', 'withDescription', 'withDocs', 'shouldExportAllSchemas', 'shouldExportAllTypes', 'withAllResponses', 'useMainResponseDescriptionAsEndpointDefinitionFallback', 'willSuppressWarnings', 'defaultStatusBehavior', 'isMainResponseStatus', 'isErrorStatus', 'isMediaTypeAllowed', 'exportAllNamedSchemas', 'complexityThreshold']);
  const hasSchemaDefaults = (value: unknown, parentKey = ''): boolean => Array.isArray(value) ? value.some(item => hasSchemaDefaults(item, parentKey)) : !!value && typeof value === 'object' && Object.entries(value).some(([key, entry]) => key === 'default' && parentKey !== 'responses' || hasSchemaDefaults(entry, key));
  const useContext = !!templatePath || !!handlebars || strategy !== 'none' || !!options.schemaRefiner || !!options.endpointDefinitionRefiner || typeof options.withAlias === 'function' || Object.entries(options).some(([key, value]) => contextOptionKeys.has(key) && value !== undefined) || (options.withDefaultValues !== false && hasSchemaDefaults(document));
  if (useContext) {
    if ((document as Record<string, unknown>).$self !== undefined && typeof (document as Record<string, unknown>).openapi === 'string' && ((document as Record<string, unknown>).openapi as string).startsWith('3.2.')) throw new Error('OTSC compatibility: OpenAPI $self is not supported by context generation');
    const context = getZodClientTemplateContext(await bundleContextDocument(document, source), options);
    if (context.schemas[clientName] !== undefined) throw new Error(`OTSC compatibility: apiClientName conflicts with generated schema ${JSON.stringify(clientName)}`);
    const template = templatePath ? (handlebars ?? getHandlebars()).compile(await readFile(templatePath, 'utf8')) : undefined;
    const renderTemplate = (data: TemplateContext) => template!(data);
    if (strategy.endsWith('-file')) {
      const output: Record<string, string> = {};
      const groupNames = Object.keys(context.endpointsGroups);
      const groupSymbols = new Set<string>();
      for (const name of groupNames) {
        const symbol = groupClientName(name);
        for (const generated of template ? [symbol] : [symbol, `create${symbol}Client`]) {
          if (groupSymbols.has(generated) || context.schemas[generated] !== undefined) throw new Error(`OTSC compatibility: conflicting group symbol ${generated}`);
          groupSymbols.add(generated);
        }
      }
      const exports = groupNames.map(name => `export { ${groupClientName(name)}${template ? '' : `, createApiClient as create${groupClientName(name)}Client`} } from ${JSON.stringify(`./${name}.js`)};`).join('\n');
      output.__index = await maybePretty(exports, prettierConfig);
      if (context.commonSchemaNames?.size) output.__common = await maybePretty(renderCommon(context), prettierConfig);
      for (const name of groupNames) {
        const group = context.endpointsGroups[name];
        const groupOptions: TemplateContextOptions = { ...context.options, groupStrategy: 'none', apiClientName: groupClientName(name) };
        const data: TemplateContext = { ...context, ...group, options: groupOptions };
        const raw = template ? renderTemplate(data) : renderSingle(data, groupOptions, group.imports);
        output[name] = await maybePretty(raw, prettierConfig);
      }
      if (!disableWriteToFile && distPath) {
        await mkdir(distPath, { recursive: true });
        for (const [name, contents] of Object.entries(output)) await writeFile(path.join(distPath, `${name === '__index' ? 'index' : name === '__common' ? 'common' : name}.ts`), contents, 'utf8');
      }
      return output;
    }
    const templateContext = { ...context, options: { ...context.options, apiClientName: clientName } };
    const raw = template ? renderTemplate(templateContext) : strategy === 'none' ? renderSingle(templateContext, templateContext.options) : renderGrouped(templateContext, templateContext.options);
    const output = await maybePretty(raw, prettierConfig);
    if (!disableWriteToFile && distPath) { await mkdir(path.dirname(distPath), { recursive: true }); await writeFile(distPath, output, 'utf8'); }
    return output;
  }
  const generatorInput = options.withDeprecatedEndpoints ? source : await filterDeprecated(document, source);
  const result = await generateClient(generatorInput, { baseUrl: options.baseUrl, schemaMetadata: false });
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error' || diagnostic.code === 'RESPONSE_SELECTION');
  if (errors.length) throw new Error(`OTSC compatibility: generation failed: ${errors.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`).join('; ')}`);
  if (result.contracts.schemas.some(schema => schema.name === clientName || `${schema.name}Reference` === clientName)) throw new Error(`OTSC compatibility: apiClientName conflicts with generated schema ${JSON.stringify(clientName)}`);
  let output = result.files[0]?.content;
  if (output === undefined) throw new Error('OTSC compatibility: generator did not produce a file');
  if (!options.withAlias) output = output.split('\n').map(line => line.startsWith('  { method: ') ? line.replace(/, alias: "(?:[^"\\]|\\.)*"/, '') : line).join('\n');
  const serverFactory = /^(export const createApiClient = .*? => )new Otsc\(baseURL \?\? ("(?:[^"\\]|\\.)*"), endpoints, \{ useOperationServers: baseURL === undefined && (true|false), \.\.\.options \}\);$/m;
  const factoryPattern = /^(export const createApiClient = .*? => )new Otsc\(\s*baseURL\s*,\s*endpoints\s*(?:,\s*(options))?\s*\);$/m;
  if (serverFactory.test(output)) {
    output = output.replace(serverFactory, (_match, prefix: string, defaultUrl: string, useServers: string) => `${prefix}{ const resolvedBaseURL = baseURL ?? ${defaultUrl}; const clientOptions = { useOperationServers: baseURL === undefined && ${useServers}, ...options }; return baseURL !== undefined || ${options.baseUrl !== undefined} || resolvedBaseURL ? new Otsc(resolvedBaseURL, endpoints, clientOptions) : new Otsc(endpoints, clientOptions); };`);
  } else if (factoryPattern.test(output)) {
    output = output.replace(factoryPattern, (_match, prefix: string, clientOptions?: string) => {
      const suffix = clientOptions ? `, ${clientOptions}` : '';
      return `${prefix}baseURL !== undefined ? new Otsc(baseURL, endpoints${suffix}) : new Otsc(endpoints${suffix});`;
    });
  } else throw new Error('OTSC compatibility: unsupported modern client factory output');
  output += `export const ${clientName} = createApiClient();\n`;
  output = await maybePretty(output, prettierConfig);
  if (!disableWriteToFile && distPath) { await mkdir(path.dirname(distPath), { recursive: true }); await writeFile(distPath, output, 'utf8'); }
  return output;
}
