
export type ParameterScalar = string | number | boolean;

export type ParameterValue = ParameterScalar | readonly ParameterScalar[] | Readonly<Record<string, ParameterScalar>>;

export interface ParameterOptions {
  name: string;
  pointer?: string;
  explode?: boolean;
}

export interface PathParameterOptions extends ParameterOptions {
  style?: 'simple' | 'label' | 'matrix';
  allowReserved?: boolean;
}

export interface QueryParameterOptions extends ParameterOptions {
  style?: 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';
  allowReserved?: boolean;
}

export interface HeaderParameterOptions extends ParameterOptions {
  style?: 'simple';
}

export interface CookieParameterOptions extends ParameterOptions {
  style?: 'form' | 'cookie';
  allowReserved?: boolean;
}

type ParsedValue = { kind: 'scalar'; value: string } | { kind: 'array'; values: string[] } | { kind: 'object'; entries: [string, string][] };

function fail(options: ParameterOptions, message: string): never {
  throw new Error(`${options.pointer ?? `parameter ${JSON.stringify(options.name)}`}: ${message}`);
}

function scalar(value: unknown, options: ParameterOptions): string {
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return fail(options, 'expected a non-null scalar (string, finite number, or boolean)');
}

function parse(value: ParameterValue, options: ParameterOptions): ParsedValue {
  if (Array.isArray(value)) {
    if (!value.length) return fail(options, 'empty arrays have no defined serialization');
    return { kind: 'array', values: Array.from(value, item => scalar(item, options)) };
  }
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return fail(options, 'expected a plain object');
    const entries = Object.keys(value).sort().map(key => [key, scalar((value as Record<string, unknown>)[key], options)] as [string, string]);
    if (!entries.length) return fail(options, 'empty objects have no defined serialization');
    return { kind: 'object', entries };
  }
  return { kind: 'scalar', value: scalar(value, options) };
}

function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeQueryValue(value: string, allowReserved: boolean, commaDelimiter: boolean): string {
  if (!allowReserved) return encode(value);
  return (value.match(/%[0-9A-Fa-f]{2}|[\s\S]/gu) ?? []).map(character => {
    if (/^%[0-9A-Fa-f]{2}$/.test(character)) return character;
    if (":/?@!$'()*;".includes(character) || (character === ',' && !commaDelimiter)) return character;
    return encode(character);
  }).join('');
}

function cookieName(value: string, options: ParameterOptions): string {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)) return fail(options, 'invalid cookie name');
  return value;
}

function cookieValue(value: string, options: ParameterOptions): string {
  if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(value)) return fail(options, 'invalid cookie value octet');
  return value;
}

function encodeCookieFormValue(value: string, allowReserved: boolean): string {
  if (!allowReserved) return encode(value);
  return (value.match(/%[0-9A-Fa-f]{2}|[\s\S]/gu) ?? []).map(character => {
    if (/^%[0-9A-Fa-f]{2}$/.test(character)) return character;
    if (":/?#[]@!$'()*+".includes(character)) return character;
    return encode(character);
  }).join('');
}

function validateOptions(options: ParameterOptions): void {
  if (typeof options.name !== 'string' || !options.name) fail(options, 'parameter name must be a non-empty string');
  if (options.explode !== undefined && typeof options.explode !== 'boolean') fail(options, 'explode must be a boolean');
}

function components(parsed: ParsedValue, encodePart: (value: string) => string, explode: boolean): string[] {
  if (parsed.kind === 'scalar') return [encodePart(parsed.value)];
  if (parsed.kind === 'array') return parsed.values.map(encodePart);
  return parsed.entries.flatMap(([key, value]) => explode ? [`${encodePart(key)}=${encodePart(value)}`] : [encodePart(key), encodePart(value)]);
}

export function serializePathParameter(options: PathParameterOptions, value: ParameterValue | undefined): string {
  validateOptions(options);
  if (options.allowReserved !== undefined && typeof options.allowReserved !== 'boolean') fail(options, 'allowReserved must be a boolean');
  const style = options.style ?? 'simple';
  if (!['simple', 'label', 'matrix'].includes(style)) fail(options, `unsupported path style ${JSON.stringify(style)}`);
  if (value === undefined) return fail(options, 'path parameter is missing');
  const parsed = parse(value, options);
  const explode = options.explode ?? false;
  const delimiters = new Set<string>();
  if (style === 'matrix') { delimiters.add(';'); delimiters.add('='); }
  if (parsed.kind !== 'scalar' && (style === 'simple' || !explode)) delimiters.add(',');
  if (parsed.kind === 'object' && explode) delimiters.add('=');
  if (parsed.kind !== 'scalar' && style === 'label' && explode) delimiters.add('.');
  const encodePart = (part: string): string => (part.match(/%[0-9A-Fa-f]{2}|[\s\S]/gu) ?? []).map(character => {
    if (options.allowReserved && /^%[0-9A-Fa-f]{2}$/.test(character)) return character;
    if (delimiters.has(character)) return `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
    if (options.allowReserved && ":@!$&'()*+,;=".includes(character)) return character;
    return encode(character);
  }).join('');
  const parts = components(parsed, encodePart, explode);
  if (style === 'simple') return parts.join(',');
  if (style === 'label') return `.${parts.join(explode ? '.' : ',')}`;
  const name = encode(options.name);
  if (!explode || parsed.kind === 'scalar') return `;${name}=${parts.join(',')}`;
  if (parsed.kind === 'array') return parts.map(part => `;${name}=${part}`).join('');
  return parts.map(part => `;${part}`).join('');
}

export function serializeQueryParameter(options: QueryParameterOptions, value: ParameterValue | undefined): string {
  validateOptions(options);
  const style = options.style ?? 'form';
  if (!['form', 'spaceDelimited', 'pipeDelimited', 'deepObject'].includes(style)) fail(options, `unsupported query style ${JSON.stringify(style)}`);
  if (options.allowReserved !== undefined && typeof options.allowReserved !== 'boolean') fail(options, 'allowReserved must be a boolean');
  const explode = options.explode ?? (style === 'form');
  if (style === 'deepObject' && !explode) fail(options, 'deepObject requires explode=true');
  if ((style === 'spaceDelimited' || style === 'pipeDelimited') && explode) fail(options, `${style} requires explode=false`);
  if (value === undefined) return '';
  const parsed = parse(value, options);
  const name = encode(options.name);
  const commaDelimiter = style === 'form' && !explode && parsed.kind !== 'scalar';
  const encodeValue = (part: string): string => encodeQueryValue(part, options.allowReserved ?? false, commaDelimiter);
  if (style === 'deepObject') {
    if (parsed.kind !== 'object') return fail(options, 'deepObject requires a flat object');
    return parsed.entries.map(([key, item]) => `${name}%5B${encode(key)}%5D=${encodeValue(item)}`).join('&');
  }
  if (style === 'spaceDelimited' || style === 'pipeDelimited') {
    if (parsed.kind === 'scalar') return fail(options, `${style} requires an array or flat object`);
    const parts = parsed.kind === 'array' ? parsed.values.map(encodeValue) : parsed.entries.flatMap(([key, item]) => [encode(key), encodeValue(item)]);
    return `${name}=${parts.join(style === 'spaceDelimited' ? '%20' : '%7C')}`;
  }
  if (parsed.kind === 'scalar') return `${name}=${encodeValue(parsed.value)}`;
  if (parsed.kind === 'array') return explode
    ? parsed.values.map(item => `${name}=${encodeValue(item)}`).join('&')
    : `${name}=${parsed.values.map(encodeValue).join(',')}`;
  return explode
    ? parsed.entries.map(([key, item]) => `${encode(key)}=${encodeValue(item)}`).join('&')
    : `${name}=${parsed.entries.flatMap(([key, item]) => [encode(key), encodeValue(item)]).join(',')}`;
}

export function serializeHeaderParameter(options: HeaderParameterOptions, value: ParameterValue | undefined): string | undefined {
  validateOptions(options);
  if (options.style !== undefined && options.style !== 'simple') fail(options, 'headers require simple style');
  if (value === undefined) return undefined;
  const result = components(parse(value, options), part => part, options.explode ?? false).join(',');
  if (/[\r\n]/.test(result)) fail(options, 'header values cannot contain CR or LF');
  return result;
}

export function serializeCookieParameter(options: CookieParameterOptions, value: ParameterValue | undefined): string {
  validateOptions(options);
  if (options.style !== undefined && options.style !== 'form' && options.style !== 'cookie') fail(options, 'cookies require form or cookie style');
  if (options.allowReserved !== undefined && typeof options.allowReserved !== 'boolean') fail(options, 'allowReserved must be a boolean');
  const form = (options.style ?? 'form') === 'form';
  const name = cookieName(form ? encode(options.name) : options.name, options);
  if (value === undefined) return '';
  const parsed = parse(value, options);
  const valuePart = (item: string): string => cookieValue(form ? encodeCookieFormValue(item, options.allowReserved ?? false) : item, options);
  const separator = form ? '&' : '; ';
  if (parsed.kind === 'scalar') return `${name}=${valuePart(parsed.value)}`;
  if (options.explode === false) fail(options, 'non-exploded cookie arrays and objects have no valid cookie representation');
  if (parsed.kind === 'array') return parsed.values.map(item => `${name}=${valuePart(item)}`).join(separator);
  return parsed.entries.map(([key, item]) => `${cookieName(form ? encode(key) : key, options)}=${valuePart(item)}`).join(separator);
}
