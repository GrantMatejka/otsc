import { AxiosHeaders } from "axios";
import {
  serializeCookieParameter,
  serializeHeaderParameter,
  serializePathParameter,
  serializeQueryParameter,
  type CookieParameterOptions,
  type HeaderParameterOptions,
  type ParameterValue,
  type PathParameterOptions,
  type QueryParameterOptions,
} from "../serialization/index.js";
import type { AnyOtscRequestOptions, OtscEndpointDefinition } from "./otsc.types.js";
import type { ReadonlyDeep } from "./utils.types.js";
import { replacePathParams } from "./utils.js";
import { encodeRequestBody, type RequestBodyFieldEncoding } from "./body/index.js";

type WireParameter = {
  name: string;
  type: string;
  serialization?: {
    in: string;
    name: string;
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
    mediaType?: string;
    contentMediaType?: string;
    encoding?: Readonly<Record<string, RequestBodyFieldEncoding>>;
  };
};

type WireEndpoint = OtscEndpointDefinition & {
  originalPath?: string;
  parameters?: readonly WireParameter[];
};

function serializeWholeQuery(mediaType: string | undefined, value: unknown, encoding?: Readonly<Record<string, RequestBodyFieldEncoding>>): string {
  if (mediaType === "application/json") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Whole-query JSON value cannot be serialized");
    return encodeURIComponent(json).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  if (mediaType === "text/plain" || mediaType === "application/jsonpath") {
    if (typeof value !== "string") throw new Error(`${mediaType} querystring requires a string`);
    return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  if (mediaType === "application/x-www-form-urlencoded") {
    const result = encodeRequestBody(value, { mediaType, encoding }).data;
    if (typeof result !== "string") throw new Error("Form querystring did not encode to text");
    return result;
  }
  throw new Error(`Unsupported querystring media type ${JSON.stringify(mediaType)}`);
}

function serializeParameterContent(mediaType: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase();
  if (normalizedMediaType === "application/json" || normalizedMediaType.endsWith("+json")) {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Parameter content cannot be JSON serialized");
    return json;
  }
  if ((normalizedMediaType.startsWith("text/") || normalizedMediaType === "application/xml" || normalizedMediaType.endsWith("+xml") || normalizedMediaType === "application/jsonpath") && typeof value === "string") return value;
  throw new Error(`Unsupported parameter content for ${JSON.stringify(mediaType)}`);
}

export function prepareWireRequest(
  endpoint: OtscEndpointDefinition | undefined,
  config: ReadonlyDeep<AnyOtscRequestOptions>,
) {
  const wireEndpoint = endpoint as WireEndpoint | undefined;
  const parameters = wireEndpoint?.parameters?.filter((parameter) => parameter.serialization) ?? [];
  const cookieValues = (config as typeof config & { cookies?: Record<string, ParameterValue> }).cookies ?? {};
  if (!parameters.length && !Object.keys(cookieValues).length) return { url: replacePathParams(config) };

  let url = parameters.some((parameter) => parameter.serialization?.in === "path")
    ? wireEndpoint?.originalPath ?? config.url
    : replacePathParams(config);
  const pathValues = new Map<string, string>();
  const headers = new AxiosHeaders(config.headers);
  const queryValues = config.queries ?? {};
  const queryParts: string[] = [];
  const queryNames = new Set<string>();
  const cookieParts: string[] = [];
  const cookieNames = new Set<string>();
  let hasQuerySerialization = false;
  let hasWholeQuery = false;

  for (const parameter of parameters) {
    const metadata = parameter.serialization!;
    const options = { ...metadata, name: metadata.name };
    if (metadata.in === "path") {
      const rawValue = config.params?.[parameter.name] as ParameterValue | undefined;
      const value = metadata.contentMediaType ? serializeParameterContent(metadata.contentMediaType, rawValue) : rawValue;
      const serialized = serializePathParameter(options as PathParameterOptions, value);
      pathValues.set(wireEndpoint?.originalPath ? metadata.name : parameter.name, serialized);
    } else if (metadata.in === "query") {
      hasQuerySerialization = true;
      queryNames.add(parameter.name);
      const rawValue = queryValues[parameter.name] as ParameterValue | undefined;
      const value = metadata.contentMediaType ? serializeParameterContent(metadata.contentMediaType, rawValue) : rawValue;
      const serialized = serializeQueryParameter(options as QueryParameterOptions, value);
      if (serialized) queryParts.push(serialized);
    } else if (metadata.in === "querystring") {
      hasQuerySerialization = true;
      hasWholeQuery = true;
      queryNames.add(parameter.name);
      const value = queryValues[parameter.name];
      if (value !== undefined) queryParts.push(serializeWholeQuery(metadata.mediaType, value, metadata.encoding));
    } else if (metadata.in === "header") {
      const rawValue = Object.entries(config.headers ?? {}).find(([name]) => name.toLowerCase() === parameter.name.toLowerCase())?.[1] as ParameterValue | undefined;
      const value = metadata.contentMediaType ? serializeParameterContent(metadata.contentMediaType, rawValue) : rawValue;
      const serialized = serializeHeaderParameter(options as HeaderParameterOptions, value);
      if (serialized !== undefined) headers.set(metadata.name, serialized);
    } else if (metadata.in === "cookie") {
      cookieNames.add(parameter.name);
      const rawValue = cookieValues[parameter.name];
      const value = metadata.contentMediaType ? serializeParameterContent(metadata.contentMediaType, rawValue) : rawValue;
      const serialized = serializeCookieParameter(options as CookieParameterOptions, value);
      if (serialized) cookieParts.push(serialized);
    } else {
      throw new Error(`Unsupported parameter serialization location ${JSON.stringify(metadata.in)}`);
    }
  }
  if (pathValues.size) {
    const placeholder = wireEndpoint?.originalPath ? /\{([^{}]+)\}/g : /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
    url = url.replace(placeholder, (match, name: string) => {
      const serialized = pathValues.get(name);
      if (serialized !== undefined) return serialized;
      const value = config.params?.[name];
      return value !== undefined ? encodeURIComponent(String(value)) : match;
    });
  }
  for (const [name, value] of Object.entries(cookieValues)) {
    if (cookieNames.has(name)) continue;
    const serialized = serializeCookieParameter({ name }, value);
    if (serialized) cookieParts.push(serialized);
  }

  if (hasQuerySerialization) {
    if (hasWholeQuery && parameters.some((parameter) => parameter.serialization?.in === "query")) {
      throw new Error("Whole-query parameters cannot be combined with individual query parameters");
    }
    for (const [name, value] of Object.entries(queryValues)) {
      if (queryNames.has(name)) continue;
      if (hasWholeQuery && value !== undefined) throw new Error("Whole-query parameters cannot be combined with other query parameters");
      const serialized = serializeQueryParameter({ name }, value as ParameterValue | undefined);
      if (serialized) queryParts.push(serialized);
    }
  }
  if (cookieParts.length) {
    if (typeof process === "undefined" || !process.versions?.node) throw new Error("Cookie parameters cannot be set directly in a browser; use browser-managed credentials");
    const existing = headers.get("Cookie");
    headers.set("Cookie", [existing, ...cookieParts].filter(Boolean).join("; "));
  }

  return {
    url,
    headers,
    ...(hasQuerySerialization ? { paramsSerializer: { serialize: () => queryParts.join("&") } } : {}),
  };
}
