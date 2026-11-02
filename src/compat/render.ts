import type { EndpointDefinitionWithRefs, TemplateContext, TemplateContextOptions } from './index.js';

type Endpoint = EndpointDefinitionWithRefs & { method: string; path: string; response: string; parameters: Record<string, unknown>[]; errors: Record<string, unknown>[] };
const literal = (value: unknown) => {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('OTSC compatibility: endpoint contains a non-serializable value');
  return result.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
};
const nameOf = (value: string) => `${value.charAt(0).toUpperCase()}${value.slice(1)}Api`;
const factoryNameOf = (value: string) => `create${nameOf(value)}Client`;
function renderEndpoint(endpoint: Endpoint): string {
  const contracts = endpoint.__responseContracts;
  const entries = Object.entries(endpoint).filter(([key, value]) => value !== undefined && !(key === 'responses' && Array.isArray(contracts)));
  if (Array.isArray(contracts)) entries.push(['responses', contracts]);
  const fields = entries.map(([key, value]) => {
    if (key === 'response') return `${literal(key)}: ${value}`;
    if (key === 'parameters' || key === 'errors' || key === 'responses' || key === 'requestBodies') {
      if (!Array.isArray(value)) throw new Error(`OTSC compatibility: invalid endpoint ${key}`);
      return `${literal(key)}: [${value.map(entry => `{ ${Object.entries(entry).filter(([, field]) => field !== undefined).map(([field, item]) => {
        if (key === 'responses' && field === 'statusCode') return `status: ${literal(/^\d+$/.test(String(item)) ? Number(item) : item)}`;
        return `${literal(field)}: ${field === 'schema' ? item : literal(item)}`;
      }).join(', ')} }`).join(', ')}]`;
    }
    return `${literal(key)}: ${literal(value)}`;
  });
  return `  { ${fields.join(', ')} },`;
}
function declarations(context: Pick<TemplateContext, 'schemas' | 'circularTypeByName'>, exported: boolean): string[] {
  return Object.entries(context.schemas).map(([name, expression]) => `${exported ? 'export ' : ''}const ${name} = ${expression}${context.circularTypeByName[name] ? ` as unknown as z.ZodType<${name}, ${name}>` : ''};`);
}
export function renderSingle(context: TemplateContext, options: TemplateContextOptions, imports: Record<string, string> = {}): string {
  const clientName = options.apiClientName ?? 'api';
  const baseUrl = literal(options.baseUrl ?? '');
  const useServers = context.endpoints.some(endpoint => typeof endpoint.server === 'string');
  const importLines = Object.entries(imports).map(([name, source]) => `import { ${name} } from ${literal(`./${source}.js`)};`);
  return [`import { z } from 'zod';`, `import { makeApi, Otsc, type OtscOptions } from 'otsc';`, ...importLines,
    ...Object.values(context.types).map(type => `export ${type};`), ...declarations(context, true), `export const schemas = { ${Object.keys(context.schemas).join(', ')} };`,
    'export const endpoints = makeApi([', ...context.endpoints.map(endpoint => renderEndpoint(endpoint as Endpoint)), '] as const);',
    `export function createApiClient(baseUrl?: string, options?: OtscOptions) { const resolvedBaseUrl = baseUrl ?? ${baseUrl}; const clientOptions = { useOperationServers: baseUrl === undefined && ${useServers}, ...options }; return baseUrl !== undefined || ${options.baseUrl !== undefined} || resolvedBaseUrl ? new Otsc(resolvedBaseUrl, endpoints, clientOptions) : new Otsc(endpoints, clientOptions); }`,
    `export const ${clientName} = createApiClient();`, ''].join('\n');
}
export function renderGrouped(context: TemplateContext, options: TemplateContextOptions): string {
  const usedNames = new Set(Object.keys(context.schemas));
  for (const name of Object.keys(context.endpointsGroups)) {
    for (const generated of [`${name}Endpoints`, nameOf(name), factoryNameOf(name)]) {
      if (usedNames.has(generated)) throw new Error(`OTSC compatibility: conflicting group symbol ${generated}`);
      usedNames.add(generated);
    }
  }
  const lines = [`import { z } from 'zod';`, `import { makeApi, Otsc, type OtscOptions } from 'otsc';`, ...Object.values(context.types).map(type => `export ${type};`), ...declarations(context, true), `export const schemas = { ${Object.keys(context.schemas).join(', ')} };`];
  for (const [name, group] of Object.entries(context.endpointsGroups)) {
    lines.push(`export const ${name}Endpoints = makeApi([`, ...group.endpoints.map(endpoint => renderEndpoint(endpoint as Endpoint)), '] as const);');
    const useServers = group.endpoints.some(endpoint => typeof endpoint.server === 'string');
    lines.push(`export function ${factoryNameOf(name)}(baseUrl?: string, options?: OtscOptions) { const resolvedBaseUrl = baseUrl ?? ${literal(options.baseUrl ?? '')}; const clientOptions = { useOperationServers: baseUrl === undefined && ${useServers}, ...options }; return baseUrl !== undefined || ${options.baseUrl !== undefined} || resolvedBaseUrl ? new Otsc(resolvedBaseUrl, ${name}Endpoints, clientOptions) : new Otsc(${name}Endpoints, clientOptions); }`);
    lines.push(`export const ${nameOf(name)} = ${factoryNameOf(name)}();`);
  }
  return lines.join('\n') + '\n';
}
export function renderCommon(context: TemplateContext): string {
  const schemas = Object.fromEntries([...context.commonSchemaNames ?? []].map(name => [name, context.schemas[name]]));
  const types = [...context.commonSchemaNames ?? []].flatMap(name => context.types[name] ? [`export ${context.types[name]};`] : []);
  return [`import { z } from 'zod';`, ...types, ...declarations({ schemas, circularTypeByName: context.circularTypeByName }, true), ''].join('\n');
}
export function groupClientName(name: string): string { return nameOf(name); }
