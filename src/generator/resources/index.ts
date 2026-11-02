export type Schema = boolean | Record<string, unknown>;

export interface ResourceDocument {
  uri: string;
  value: unknown;
  kind?: 'schema' | 'document';
  baseUri?: string;
  referenceSiblingsIgnored?: boolean;
  schemaPointers?: readonly string[];
}

export interface ResolvedResource {
  id: string;
  value: unknown;
  base: string;
}

export class ResourceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceResolutionError';
  }
}

interface UriParts {
  scheme?: string;
  authority?: string;
  path: string;
  query?: string;
  fragment?: string;
}

function parseUri(uri: string): UriParts {
  const match = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?$/.exec(uri);
  if (!match || /[\u0000-\u0020<>"{}|\\^`]/.test(uri) || /%(?![0-9a-fA-F]{2})/.test(uri)) {
    throw new ResourceResolutionError(`Invalid URI reference ${JSON.stringify(uri)}`);
  }
  return { scheme: match[2], authority: match[4], path: match[5], query: match[7], fragment: match[9] };
}

function removeDotSegments(path: string): string {
  let remaining = path;
  let output = '';
  while (remaining) {
    if (remaining.startsWith('../')) remaining = remaining.slice(3);
    else if (remaining.startsWith('./')) remaining = remaining.slice(2);
    else if (remaining.startsWith('/./')) remaining = remaining.slice(2);
    else if (remaining === '/.') remaining = '/';
    else if (remaining.startsWith('/../')) {
      remaining = remaining.slice(3);
      output = output.replace(/\/?[^/]*$/, '');
    } else if (remaining === '/..') {
      remaining = '/';
      output = output.replace(/\/?[^/]*$/, '');
    } else if (remaining === '.' || remaining === '..') remaining = '';
    else {
      const segment = /^\/?[^/]*/.exec(remaining)![0];
      output += segment;
      remaining = remaining.slice(segment.length);
    }
  }
  return output;
}

function serializeUri(parts: UriParts): string {
  return `${parts.scheme === undefined ? '' : `${parts.scheme}:`}${parts.authority === undefined ? '' : `//${parts.authority}`}${parts.path}${parts.query === undefined ? '' : `?${parts.query}`}${parts.fragment === undefined ? '' : `#${parts.fragment}`}`;
}

export function resolveUri(reference: string, base: string): string {
  const target = parseUri(reference);
  const origin = parseUri(base);
  if (!origin.scheme) throw new ResourceResolutionError(`Base URI must be absolute: ${JSON.stringify(base)}`);
  let result: UriParts;
  if (target.scheme !== undefined) result = { ...target, path: removeDotSegments(target.path) };
  else if (target.authority !== undefined) result = { ...target, scheme: origin.scheme, path: removeDotSegments(target.path) };
  else if (!target.path) result = { ...target, scheme: origin.scheme, authority: origin.authority, path: origin.path, query: target.query ?? origin.query };
  else {
    const merged = target.path.startsWith('/') ? target.path : origin.authority !== undefined && !origin.path ? `/${target.path}` : `${origin.path.replace(/[^/]*$/, '')}${target.path}`;
    result = { ...target, scheme: origin.scheme, authority: origin.authority, path: removeDotSegments(merged) };
  }
  return serializeUri(result);
}

function documentUri(uri: string): string {
  const parts = parseUri(uri);
  if (!parts.scheme) throw new ResourceResolutionError(`Document URI must be absolute: ${JSON.stringify(uri)}`);
  if (parts.fragment !== undefined && parts.fragment !== '') throw new ResourceResolutionError(`Document URI must not contain a fragment: ${JSON.stringify(uri)}`);
  return serializeUri({ ...parts, path: removeDotSegments(parts.path), fragment: undefined });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSchema(value: unknown): value is Schema {
  return typeof value === 'boolean' || isObject(value);
}

function pointerToken(token: string): string {
  return encodeURIComponent(token.replace(/~/g, '~0').replace(/\//g, '~1'));
}

function pointerTokens(fragment: string): string[] {
  let decoded: string;
  try { decoded = decodeURIComponent(fragment); }
  catch { throw new ResourceResolutionError(`Invalid fragment encoding ${JSON.stringify(fragment)}`); }
  if (!decoded.startsWith('/')) throw new ResourceResolutionError(`Invalid JSON pointer ${JSON.stringify(fragment)}`);
  return decoded.slice(1).split('/').map(token => {
    if (/~(?![01])/.test(token)) throw new ResourceResolutionError(`Invalid JSON pointer escape in ${JSON.stringify(fragment)}`);
    return token.replace(/~1/g, '/').replace(/~0/g, '~');
  });
}

function pointerFor(tokens: readonly string[]): string {
  return tokens.length ? `#/${tokens.map(pointerToken).join('/')}` : '';
}

function lookup(root: unknown, tokens: readonly string[], location: string): unknown {
  let value = root;
  for (const token of tokens) {
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token) || Number(token) >= value.length) throw new ResourceResolutionError(`JSON pointer not found: ${location}`);
      value = value[Number(token)];
    } else if (isObject(value) && Object.prototype.hasOwnProperty.call(value, token)) value = value[token];
    else throw new ResourceResolutionError(`JSON pointer not found: ${location}`);
  }
  return value;
}

const mapKeywords = ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'];
const singleKeywords = ['additionalProperties', 'unevaluatedProperties', 'propertyNames', 'items', 'additionalItems', 'contains', 'unevaluatedItems', 'not', 'if', 'then', 'else', 'contentSchema'];
const arrayKeywords = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];

export class ResourceIndex {
  private readonly roots = new Map<string, unknown>();
  private readonly locations = new Map<string, ResolvedResource>();
  private readonly anchors = new Map<string, ResolvedResource>();
  private readonly documentBases = new Map<string, string>();

  constructor(documents: readonly ResourceDocument[]) {
    for (const document of documents) {
      const uri = documentUri(document.uri);
      if (this.roots.has(uri)) throw new ResourceResolutionError(`Duplicate document URI ${JSON.stringify(uri)}`);
      this.roots.set(uri, document.value);
    }
    for (const document of documents) {
      const uri = documentUri(document.uri);
      const base = document.baseUri === undefined ? uri : documentUri(document.baseUri);
      if (this.roots.has(base) && this.roots.get(base) !== document.value) throw new ResourceResolutionError(`Duplicate document base URI ${JSON.stringify(base)}`);
      this.roots.set(base, document.value);
      this.documentBases.set(uri, base);
      this.documentBases.set(base, base);
    }
    for (const document of documents) {
      const uri = documentUri(document.uri);
      const base = this.documentBases.get(uri)!;
      if ((document.kind ?? 'schema') === 'schema') this.indexSchema(document.value, uri, [], base, [], new Set(), document.referenceSiblingsIgnored ?? false);
      for (const pointer of document.schemaPointers ?? []) {
        const fragment = pointer.startsWith('#') ? pointer.slice(1) : pointer;
        const tokens = fragment === '' ? [] : pointerTokens(fragment);
        if (this.locations.has(`${uri}${pointerFor(tokens)}`)) continue;
        this.indexSchema(lookup(document.value, tokens, `${uri}${pointerFor(tokens)}`), uri, tokens, base, tokens, new Set(), document.referenceSiblingsIgnored ?? false);
      }
    }
  }

  private register(map: Map<string, ResolvedResource>, key: string, entry: ResolvedResource): void {
    const existing = map.get(key);
    if (existing && (existing.value !== entry.value || existing.id !== entry.id || existing.base !== entry.base)) throw new ResourceResolutionError(`Duplicate schema identifier ${JSON.stringify(key)}`);
    map.set(key, entry);
  }

  private pointerLocation(uri: string, tokens: readonly string[]): { id: string; indexed?: ResolvedResource; parent?: ResolvedResource } {
    let id = uri;
    let indexed = this.locations.get(id);
    let parent = indexed;
    let pending: string[] = [];
    const append = () => {
      const parts = parseUri(id);
      const prefix = parts.fragment ? pointerTokens(parts.fragment) : [];
      return `${serializeUri({ ...parts, fragment: undefined })}${pointerFor([...prefix, ...pending])}`;
    };
    for (const token of tokens) {
      pending.push(token);
      const candidate = append();
      indexed = this.locations.get(candidate);
      if (indexed) {
        id = indexed.id;
        parent = indexed;
        pending = [];
      }
    }
    return { id: append(), indexed, parent };
  }

  private indexSchema(value: unknown, document: string, documentPath: string[], resource: string, resourcePath: string[], ancestors: Set<object>, referenceSiblingsIgnored: boolean): void {
    if (!isSchema(value)) throw new ResourceResolutionError(`Expected schema at ${document}${pointerFor(documentPath)}`);
    if (isObject(value) && ancestors.has(value)) throw new ResourceResolutionError(`Cyclic JavaScript object at ${document}${pointerFor(documentPath)}; use $ref`);
    let base = resource;
    let path = resourcePath;
    const ignoreSiblings = referenceSiblingsIgnored && isObject(value) && typeof value.$ref === 'string';
    if (isObject(value) && value.$id !== undefined && !ignoreSiblings) {
      if (typeof value.$id !== 'string') throw new ResourceResolutionError(`Invalid $id at ${document}${pointerFor(documentPath)}`);
      const resolved = resolveUri(value.$id, resource);
      const parts = parseUri(resolved);
      if (parts.fragment !== undefined && parts.fragment !== '') throw new ResourceResolutionError(`$id must not contain a fragment at ${document}${pointerFor(documentPath)}`);
      base = serializeUri({ ...parts, fragment: undefined });
      path = [];
      if (this.roots.has(base) && this.roots.get(base) !== value && !(base === document && documentPath.length === 0)) throw new ResourceResolutionError(`Duplicate schema resource URI ${JSON.stringify(base)}`);
      this.roots.set(base, value);
    }
    const entry = { id: `${base}${pointerFor(path)}`, value, base };
    this.register(this.locations, `${document}${pointerFor(documentPath)}`, entry);
    this.register(this.locations, `${resource}${pointerFor(resourcePath)}`, entry);
    this.register(this.locations, entry.id, entry);
    if (!isObject(value)) return;
    if (ignoreSiblings) return;
    if (value.$dynamicRef !== undefined) throw new ResourceResolutionError(`Dynamic reference at ${document}${pointerFor(documentPath)} requires dynamic scope and is unsupported`);
    for (const keyword of ['$anchor', '$dynamicAnchor']) {
      const anchor = value[keyword];
      if (anchor === undefined) continue;
      if (typeof anchor !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]*$/.test(anchor)) throw new ResourceResolutionError(`Invalid ${keyword} at ${document}${pointerFor(documentPath)}`);
      this.register(this.anchors, `${base}#${anchor}`, entry);
    }
    const nextAncestors = new Set(ancestors).add(value);
    const visit = (child: unknown, segments: string[]) => {
      if (isSchema(child)) this.indexSchema(child, document, [...documentPath, ...segments], base, [...path, ...segments], nextAncestors, referenceSiblingsIgnored);
    };
    for (const keyword of mapKeywords) {
      const children = value[keyword];
      if (isObject(children)) for (const [name, child] of Object.entries(children)) visit(child, [keyword, name]);
    }
    for (const keyword of singleKeywords) {
      const child = value[keyword];
      if (keyword === 'items' && Array.isArray(child)) child.forEach((item, index) => visit(item, [keyword, String(index)]));
      else visit(child, [keyword]);
    }
    for (const keyword of arrayKeywords) {
      const children = value[keyword];
      if (Array.isArray(children)) children.forEach((child, index) => visit(child, [keyword, String(index)]));
    }
    if (isObject(value.dependencies)) for (const [name, child] of Object.entries(value.dependencies)) visit(child, ['dependencies', name]);
  }

  schemaLocation(reference: string, base: string): ResolvedResource | undefined {
    const absolute = resolveUri(reference, base);
    const parts = parseUri(absolute);
    const uri = serializeUri({ ...parts, fragment: undefined });
    let fragment: string;
    try { fragment = decodeURIComponent(parts.fragment ?? ''); }
    catch { throw new ResourceResolutionError(`Invalid fragment encoding ${JSON.stringify(parts.fragment)}`); }
    if (fragment && !fragment.startsWith('/')) return this.anchors.get(`${uri}#${fragment}`);
    const tokens = parts.fragment ? pointerTokens(parts.fragment) : [];
    return this.pointerLocation(uri, tokens).indexed;
  }

  resolve(reference: string, base: string, options: { dynamic?: boolean } = {}): ResolvedResource {
    if (options.dynamic) throw new ResourceResolutionError(`Dynamic reference ${JSON.stringify(reference)} requires dynamic scope and is unsupported`);
    const absolute = resolveUri(reference, base);
    const parts = parseUri(absolute);
    const uri = serializeUri({ ...parts, fragment: undefined });
    if (!this.roots.has(uri)) throw new ResourceResolutionError(`Unknown resource ${JSON.stringify(uri)}`);
    let decodedFragment = '';
    try { decodedFragment = decodeURIComponent(parts.fragment ?? ''); }
    catch { throw new ResourceResolutionError(`Invalid fragment encoding ${JSON.stringify(parts.fragment)}`); }
    if (decodedFragment && !decodedFragment.startsWith('/')) {
      const anchor = decodedFragment;
      const result = this.anchors.get(`${uri}#${anchor}`);
      if (!result) throw new ResourceResolutionError(`Unknown anchor ${JSON.stringify(absolute)}`);
      return result;
    }
    const tokens = parts.fragment ? pointerTokens(parts.fragment) : [];
    const location = `${uri}${pointerFor(tokens)}`;
    const { id, indexed, parent } = this.pointerLocation(uri, tokens);
    if (indexed) return indexed;
    const value = lookup(this.roots.get(uri), tokens, location);
    if (parent) return { id, value, base: parent.base };
    const documentBase = this.documentBases.get(uri) ?? uri;
    return { id: `${documentBase}${pointerFor(tokens)}`, value, base: documentBase };
  }
}

export function createResourceIndex(documents: readonly ResourceDocument[]): ResourceIndex {
  return new ResourceIndex(documents);
}
