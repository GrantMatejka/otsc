import { AxiosHeaders, type AxiosInstance } from "axios";

export function defaultRequestHeaders(defaults: AxiosInstance["defaults"]["headers"] | undefined, method: string): AxiosHeaders {
  const normalized = method.toLowerCase();
  const groups = new Set(["common", "get", "delete", "head", "options", "post", "put", "patch", "purge", "link", "unlink", "query", normalized]);
  const flat = Object.fromEntries(Object.entries(defaults ?? {}).filter(([key]) => !groups.has(key.toLowerCase())));
  return AxiosHeaders.concat(defaults?.common as Record<string, string> | undefined, defaults?.[normalized] as Record<string, string> | undefined, flat);
}
