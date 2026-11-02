import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const methods = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace', 'query'];
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const dataKeys = new Set(['example', 'examples', 'default', 'const', 'enum', 'externalDocs', 'discriminator']);

/** Preserve the source of every reference when an edited document becomes an in-memory input. */
export async function filterDeprecated(document: object, input: object | string): Promise<object | string> {
  const rootUrl = new URL(typeof input === 'string'
    ? /^(https?:|file:)/i.test(input) ? new URL(input).href : pathToFileURL(path.resolve(input)).href
    : 'memory:///openapi.json');
  rootUrl.hash = '';
  const rootUri = rootUrl.href;
  const resources = new Map<string, { value: any; uri: string }>([[rootUri, { value: document, uri: rootUri }]]);
  const clone = structuredClone(document) as Record<string, any>;
  let changed = false;
  async function resolveItem(item: any): Promise<{ item: any; uri: string }> {
    let uri = rootUri;
    const seen = new Set<string>();
    while (object(item) && typeof item.$ref === 'string') {
      let target: URL;
      try { target = new URL(item.$ref, uri); } catch { throw new Error(`OTSC compatibility: invalid path item reference ${item.$ref}`); }
      const fragment = target.hash.slice(1);
      target.hash = '';
      const resourceUri = target.href;
      const key = `${resourceUri}#${fragment}`;
      if (seen.has(key)) throw new Error(`OTSC compatibility: path item reference cycle at ${key}`);
      seen.add(key);
      if (!resources.has(resourceUri)) {
        let content: string;
        let finalUri = resourceUri;
        if (resourceUri.startsWith('file:')) content = await readFile(fileURLToPath(resourceUri), 'utf8');
        else if (/^https?:/.test(resourceUri)) {
          const response = await fetch(resourceUri);
          if (!response.ok) throw new Error(`OTSC compatibility: HTTP ${response.status} loading ${resourceUri}`);
          content = await response.text();
          finalUri = response.url || resourceUri;
        } else throw new Error(`OTSC compatibility: cannot load path item resource ${resourceUri}`);
        const resource = { value: parse(content), uri: finalUri };
        resources.set(resourceUri, resource);
        if (!resources.has(finalUri)) resources.set(finalUri, resource);
      }
      const resource = resources.get(resourceUri)!;
      item = resource.value;
      let pointer: string;
      try { pointer = decodeURIComponent(fragment); } catch { throw new Error(`OTSC compatibility: invalid reference fragment ${key}`); }
      if (pointer && !pointer.startsWith('/')) throw new Error(`OTSC compatibility: unsupported path item fragment ${key}`);
      for (const token of pointer ? pointer.slice(1).split('/') : []) {
        if (/~(?![01])/.test(token)) throw new Error(`OTSC compatibility: invalid reference fragment ${key}`);
        const part = token.replace(/~1/g, '/').replace(/~0/g, '~');
        if ((!object(item) && !Array.isArray(item)) || !Object.hasOwn(item, part)) throw new Error(`OTSC compatibility: path item reference not found ${key}`);
        item = (item as Record<string, any>)[part];
      }
      uri = resource.uri;
    }
    return { item, uri };
  }
  // Rebase only values that the generator interprets as references; examples and
  // extensions are data and must not be rewritten.
  function rebase(value: any, uri: string, localRoot: boolean): void {
    if (Array.isArray(value)) { value.forEach(entry => rebase(entry, uri, localRoot)); return; }
    if (!object(value)) return;
    if ('$id' in value || '$dynamicRef' in value) throw new Error('OTSC compatibility: cannot safely rebase filtered documents containing $id or $dynamicRef');
    if (typeof value.$ref === 'string' && !(localRoot && value.$ref.startsWith('#'))) {
      try {
        const target = new URL(value.$ref, uri);
        const fragment = target.hash;
        target.hash = '';
        value.$ref = localRoot && target.href === rootUri ? fragment || '#' : new URL(value.$ref, uri).href;
      } catch { throw new Error(`OTSC compatibility: invalid reference ${value.$ref} in ${uri}`); }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === '$ref' || key.startsWith('x-') || dataKeys.has(key)) continue;
      if (key === 'servers' && Array.isArray(entry) && /^https?:/.test(uri)) {
        for (const server of entry) if (object(server) && typeof server.url === 'string' && !/^[a-z][a-z\d+.-]*:/i.test(server.url)) {
          if (/[{}]/.test(server.url)) throw new Error(`OTSC compatibility: cannot safely rebase relative server template ${server.url}`);
          server.url = new URL(server.url, uri).href;
        }
      }
      rebase(entry, uri, localRoot);
    }
  }
  if (object(clone.paths)) for (const [route, raw] of Object.entries(clone.paths)) {
    const resolved = await resolveItem(raw);
    if (!object(resolved.item)) continue;
    const deprecated = methods.filter(method => object(resolved.item[method]) && resolved.item[method].deprecated);
    if (!deprecated.length) continue;
    const item = structuredClone(resolved.item);
    for (const method of deprecated) delete item[method];
    if (resolved.uri !== rootUri) rebase(item, resolved.uri, false);
    clone.paths[route] = item;
    changed = true;
  }
  if (!changed) return input;
  if (typeof input === 'string') rebase(clone, rootUri, true);
  return clone;
}
