import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const escapePointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const localToken = (value: string) => encodeURIComponent(escapePointer(value));
const dataKeys = new Set(['example', 'examples', 'default', 'const', 'enum', 'externalDocs', 'discriminator']);
const schemaSingles = new Set(['items', 'additionalItems', 'additionalProperties', 'not', 'if', 'then', 'else', 'propertyNames', 'contains', 'contentSchema', 'unevaluatedProperties', 'unevaluatedItems']);
const schemaArrays = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const schemaMaps = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);

/** Convert reference targets to local components without dereferencing schema cycles. */
export async function bundleContextDocument(document: object, input: object | string): Promise<object> {
  const rootUri = typeof input === 'string'
    ? /^(https?:|file:)/i.test(input) ? new URL(input).href : pathToFileURL(path.resolve(input)).href
    : 'memory:///openapi.json';
  const rootUrl = new URL(rootUri);
  rootUrl.hash = '';
  const sourceUri = rootUrl.href;
  const resources = new Map<string, { value: unknown; uri: string }>([[sourceUri, { value: document, uri: sourceUri }]]);
  const root = structuredClone(document) as Record<string, any>;
  if (!object(root)) throw new Error('OTSC compatibility: expected an OpenAPI document object');
  if (root.components !== undefined && !object(root.components)) throw new Error('OTSC compatibility: invalid components');
  root.components ??= {};
  if (root.components.schemas !== undefined && !object(root.components.schemas)) throw new Error('OTSC compatibility: invalid component schemas');
  root.components.schemas ??= {};
  const schemas = root.components.schemas as Record<string, any>;
  const schemaRefs = new Map<string, string>();
  const otherRefs = new Map<string, string>();
  const discoveredSchemas = new Map<string, { name: string; value?: unknown }>();
  const references: Array<{ value: Record<string, any>; key: string }> = [];
  const pending: Array<{ value: unknown; uri: string; schema: boolean; assign: (value: unknown) => void }> = [];
  for (const name of Object.keys(schemas)) schemaRefs.set(`${sourceUri}#/components/schemas/${escapePointer(name)}`, `#/components/schemas/${localToken(name)}`);
  let nextOther = 0;
  const otherTargets: Record<string, unknown> = Object.create(null);
  let storageKey = 'x-otsc-bundled';
  for (let suffix = 2; Object.hasOwn(root.components, storageKey); suffix++) storageKey = `x-otsc-bundled-${suffix}`;

  async function load(uri: string): Promise<{ value: unknown; uri: string }> {
    const cached = resources.get(uri);
    if (cached) return cached;
    let content: string;
    let finalUri = uri;
    if (uri.startsWith('file:')) content = await readFile(fileURLToPath(uri), 'utf8');
    else if (/^https?:/.test(uri)) {
      const response = await fetch(uri);
      if (!response.ok) throw new Error(`OTSC compatibility: HTTP ${response.status} loading ${uri}`);
      content = await response.text();
      finalUri = response.url || uri;
    } else throw new Error(`OTSC compatibility: cannot resolve external reference ${uri} without a file or HTTP base`);
    const resource = { value: parse(content), uri: finalUri };
    resources.set(uri, resource);
    if (!resources.has(finalUri)) resources.set(finalUri, resource);
    return resource;
  }
  async function target(ref: string, base: string): Promise<{ key: string; uri: string; value: unknown; name: string; local: string }> {
    let url: URL;
    try { url = new URL(ref, base); } catch { throw new Error(`OTSC compatibility: invalid reference ${ref} in ${base}`); }
    let fragment: string;
    try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { throw new Error(`OTSC compatibility: invalid reference fragment ${ref}`); }
    if (fragment && !fragment.startsWith('/')) throw new Error(`OTSC compatibility: unsupported reference fragment ${ref}`);
    url.hash = '';
    const resource = await load(url.href);
    const uri = resource.uri;
    let value = resource.value;
    const parts = fragment ? fragment.slice(1).split('/') : [];
    for (const part of parts) {
      if (/~(?![01])/.test(part)) throw new Error(`OTSC compatibility: invalid JSON pointer ${ref}`);
      const name = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if ((!object(value) && !Array.isArray(value)) || !Object.hasOwn(value, name)) throw new Error(`OTSC compatibility: reference not found ${ref} in ${base}`);
      value = (value as Record<string, unknown>)[name];
    }
    const normalized = parts.map(part => escapePointer(part.replace(/~1/g, '/').replace(/~0/g, '~'))).join('/');
    return { key: `${uri}#${parts.length ? `/${normalized}` : ''}`, local: `#${parts.length ? `/${parts.map(part => localToken(part.replace(/~1/g, '/').replace(/~0/g, '~'))).join('/')}` : ''}`, uri, value, name: parts.length ? parts[parts.length - 1].replace(/~1/g, '/').replace(/~0/g, '~') : path.basename(new URL(uri).pathname).replace(/\.[^.]+$/, '') };
  }
  async function walk(value: any, uri: string, schema: boolean): Promise<void> {
    if (Array.isArray(value)) { for (const item of value) await walk(item, uri, schema); return; }
    if (!object(value)) return;
    if ('$id' in value || '$anchor' in value || '$dynamicAnchor' in value || '$dynamicRef' in value || '$recursiveRef' in value || '$recursiveAnchor' in value) throw new Error(`OTSC compatibility: cannot safely bundle schema resource identifiers or dynamic references in ${uri}`);
    if (typeof value.$ref === 'string') {
      const resolved = await target(value.$ref, uri);
      if (!object(resolved.value) && !(schema && typeof resolved.value === 'boolean')) throw new Error(`OTSC compatibility: reference target is not an object: ${value.$ref}`);
      if (schema) {
        if (!schemaRefs.has(resolved.key) && !discoveredSchemas.has(resolved.key)) {
          const entry: { name: string; value?: unknown } = { name: resolved.name };
          discoveredSchemas.set(resolved.key, entry);
          pending.push({ value: resolved.value, uri: resolved.uri, schema: true, assign: copy => { entry.value = copy; } });
        }
        references.push({ value, key: resolved.key });
      } else {
        let local = otherRefs.get(resolved.key);
        if (!local) {
          const name = `ref${++nextOther}`;
          local = `#/components/${storageKey}/${name}`;
          otherRefs.set(resolved.key, local);
          pending.push({ value: resolved.value, uri: resolved.uri, schema: false, assign: entry => { otherTargets[name] = entry; } });
        }
        value.$ref = local;
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' || key.startsWith('x-') || dataKeys.has(key)) continue;
      if (key === 'servers' && Array.isArray(entry) && /^https?:/.test(uri) && uri !== sourceUri) {
        for (const server of entry) if (object(server) && typeof server.url === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(server.url)) {
          if (/[{}]/.test(server.url)) throw new Error(`OTSC compatibility: cannot safely rebase relative server template ${server.url}`);
          server.url = new URL(server.url, uri).href;
        }
      }
      if (schema && schemaMaps.has(key) && object(entry)) { for (const child of Object.values(entry)) await walk(child, uri, true); }
      else if (schema && (schemaSingles.has(key) || schemaArrays.has(key))) await walk(entry, uri, true);
      else if (!schema && key === 'schemas' && object(entry) && value === root.components) { for (const child of Object.values(entry)) await walk(child, uri, true); }
      else await walk(entry, uri, !schema && key === 'schema');
    }
  }
  await walk(root, sourceUri, false);
  for (let i = 0; i < pending.length; i++) {
    const item = pending[i];
    const copy = structuredClone(item.value);
    item.assign(copy);
    await walk(copy, item.uri, item.schema);
  }
  // Allocate names after discovery so traversal order cannot change collision suffixes.
  for (const [key, entry] of [...discoveredSchemas].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const base = entry.name.replace(/[^\w$]+/g, '_') || 'Schema';
    let name = base, suffix = 2;
    while (Object.hasOwn(schemas, name)) name = `${base}_${suffix++}`;
    Object.defineProperty(schemas, name, { value: entry.value, enumerable: true, configurable: true, writable: true });
    schemaRefs.set(key, `#/components/schemas/${localToken(name)}`);
  }
  for (const reference of references) reference.value.$ref = schemaRefs.get(reference.key)!;
  if (nextOther) {
    root.components[storageKey] = otherTargets;
  }
  return root;
}
