import { AxiosError } from "axios";
import { ReadonlyDeep } from "./utils.types.js";
import {
  AnyOtscRequestOptions,
  OtscEndpointDefinition,
  OtscEndpointDefinitions,
} from "./otsc.types.js";

/**
 * omit properties from an object
 * @param obj - the object to omit properties from
 * @param keys - the keys to omit
 * @returns the object with the omitted properties
 */
export function omit<T, K extends keyof T>(
  obj: T | undefined,
  keys: K[]
): Omit<T, K> {
  const ret = { ...obj } as T;
  for (const key of keys) {
    delete ret[key];
  }
  return ret;
}

/**
 * pick properties from an object
 * @param obj - the object to pick properties from
 * @param keys - the keys to pick
 * @returns the object with the picked properties
 */
export function pick<T, K extends keyof T>(
  obj: T | undefined,
  keys: K[]
): Pick<T, K> {
  const ret = {} as Pick<T, K>;
  if (obj) {
    for (const key of keys) {
      ret[key] = obj[key];
    }
  }
  return ret;
}

/**
 * set first letter of a string to uppercase
 * @param str - the string to capitalize
 * @returns - the string with the first letter uppercased
 */
export function capitalize<T extends string>(str: T): Capitalize<T> {
  return (str.charAt(0).toUpperCase() + str.slice(1)) as Capitalize<T>;
}

const paramsRegExp = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;

export function replacePathParams(
  config: ReadonlyDeep<AnyOtscRequestOptions>
) {
  let result: string = config.url;
  const params = config.params;
  if (params) {
    result = result.replace(paramsRegExp, (match, key) =>
      key in params ? encodeURIComponent(String(params[key])) : match
    );
  }
  return result;
}

export function findEndpoint(
  api: OtscEndpointDefinitions,
  method: string,
  path: string
) {
  return api.find((e) => e.method === method && e.path === path);
}

export function findEndpointByAlias(
  api: OtscEndpointDefinitions,
  alias: string
) {
  return api.find((e) => e.alias === alias);
}

export function findEndpointErrors(
  endpoint: OtscEndpointDefinition,
  err: AxiosError
) {
  const matchingErrors = endpoint.errors?.filter(
    (error) => error.status === err.response!.status
  );
  if (matchingErrors && matchingErrors.length > 0) return matchingErrors;
  const classErrors = endpoint.errors?.filter(
    (error) => error.status === `${Math.floor(err.response!.status / 100)}XX`
  );
  if (classErrors && classErrors.length > 0) return classErrors;
  return endpoint.errors?.filter((error) => error.status === "default");
}

export function findEndpointErrorsByPath(
  api: OtscEndpointDefinitions,
  method: string,
  path: string,
  err: AxiosError
) {
  const endpoint = findEndpoint(api, method, path);
  return endpoint &&
    err.config &&
    err.config.url &&
    endpoint.method.toLowerCase() === err.config.method?.toLowerCase() &&
    pathMatchesUrl(endpoint.path, err.config.url, endpoint.originalPath)
    ? findEndpointErrors(endpoint, err)
    : undefined;
}

export function findEndpointErrorsByAlias(
  api: OtscEndpointDefinitions,
  alias: string,
  err: AxiosError
) {
  const endpoint = findEndpointByAlias(api, alias);

  return endpoint &&
    err.config &&
    err.config.url &&
    endpoint.method.toLowerCase() === err.config.method?.toLowerCase() &&
    pathMatchesUrl(endpoint.path, err.config.url, endpoint.originalPath)
    ? findEndpointErrors(endpoint, err)
    : undefined;
}

export function pathMatchesUrl(path: string, url: string, originalPath?: string) {
  const template = originalPath ?? path;
  const matcher = originalPath ? /\{[^{}]+\}/g : /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let pattern = "";
  let offset = 0;
  for (const match of template.matchAll(matcher)) {
    pattern += escape(template.slice(offset, match.index)) + "[^/]*";
    offset = match.index + match[0].length;
  }
  pattern += escape(template.slice(offset));
  return new RegExp(`^${pattern}$`).test(url.split("?", 1)[0]!);
}
