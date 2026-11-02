import { AxiosHeaders } from "axios";
import type { AnyOtscRequestOptions, OtscEndpointDefinition, OtscOptions } from "./otsc.types.js";
import type { ReadonlyDeep } from "./utils.types.js";

type PasswordCredential = { username: string; password: string };
type CredentialValue = string | PasswordCredential;
type CredentialProvider = CredentialValue | (() => CredentialValue | undefined | Promise<CredentialValue | undefined>);
type SecurityScheme = { type: string; in?: string; name?: string; scheme?: string };
type SecurityMetadata = {
  requirements: readonly Readonly<Record<string, readonly string[]>>[];
  schemes: Readonly<Record<string, SecurityScheme>>;
};
type SecurityEvaluation = {
  allowMissing?: boolean;
  cache?: Map<string, Promise<CredentialValue | undefined>>;
  defaultHeaders?: AxiosHeaders;
  defaultAuth?: PasswordCredential;
};

function securityMetadata(endpoint: OtscEndpointDefinition | undefined): SecurityMetadata | undefined {
  const declared = endpoint?.security;
  return Array.isArray(declared)
    ? { requirements: declared, schemes: endpoint?.securitySchemes ?? {} }
    : declared as SecurityMetadata | undefined;
}

export function hasDeclaredCredentialParameter(endpoint: OtscEndpointDefinition | undefined): boolean {
  const security = securityMetadata(endpoint);
  if (!security?.requirements.length || !endpoint?.parameters) return false;
  const names = new Set(security.requirements.flatMap(requirement => Object.keys(requirement)));
  return endpoint.parameters.some(parameter => [...names].some(name => {
    const scheme = security.schemes[name];
    if (!scheme) return false;
    if (scheme.type === "apiKey" && scheme.name) return parameter.type.toLowerCase() === scheme.in && (scheme.in === "header" ? parameter.name.toLowerCase() === scheme.name.toLowerCase() : parameter.name === scheme.name);
    return parameter.type === "Header" && parameter.name.toLowerCase() === "authorization" && (scheme.type === "http" || scheme.type === "oauth2" || scheme.type === "openIdConnect");
  }));
}

export function encodeBasic(credential: PasswordCredential): string {
  if (credential.username.includes(":")) throw new Error("Basic authentication usernames cannot contain a colon");
  const bytes = new TextEncoder().encode(`${credential.username}:${credential.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function applySecurity(
  endpoint: OtscEndpointDefinition | undefined,
  options: OtscOptions,
  config: ReadonlyDeep<AnyOtscRequestOptions>,
  evaluation: SecurityEvaluation = {},
): Promise<ReadonlyDeep<AnyOtscRequestOptions>> {
  const security = securityMetadata(endpoint);
  const providers = (options as OtscOptions & { credentials?: Readonly<Record<string, CredentialProvider>> }).credentials;
  if (!security?.requirements.length || !providers || !Object.keys(providers).length) return config;

  const suppliedHeaders = AxiosHeaders.concat(evaluation.defaultHeaders, config.headers);
  const hasSuppliedCredential = (scheme: SecurityScheme | undefined): boolean => {
    if (!scheme) return false;
    if (scheme.type === "apiKey" && scheme.name) {
      if (scheme.in === "header") return suppliedHeaders.has(scheme.name);
      if (scheme.in === "query") return config.queries?.[scheme.name] !== undefined;
      if (scheme.in === "cookie") {
        if (config.cookies?.[scheme.name] !== undefined) return true;
        const cookie = suppliedHeaders.get("Cookie");
        return typeof cookie === "string" && cookie.split(";").some(part => part.trim().startsWith(`${scheme.name}=`));
      }
    }
    if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic" && (config.auth ?? evaluation.defaultAuth)) return true;
    return ((scheme.type === "http" && ["basic", "bearer"].includes(scheme.scheme?.toLowerCase() ?? "")) || scheme.type === "oauth2" || scheme.type === "openIdConnect") && suppliedHeaders.has("Authorization");
  };
  const cache = evaluation.cache ?? new Map<string, Promise<CredentialValue | undefined>>();
  const credentialFor = (name: string) => {
    if (!cache.has(name)) {
      const provider = providers[name];
      cache.set(name, Promise.resolve(typeof provider === "function" ? provider() : provider));
    }
    return cache.get(name)!;
  };
  let selected: Array<[string, CredentialValue | undefined]> | undefined;
  const alternatives = security.requirements.map(requirement => {
    const names = Object.keys(requirement);
    return { names, supplied: names.map(name => hasSuppliedCredential(security.schemes[name])) };
  });
  // Prefer an explicitly supplied credential over a configured provider, while
  // retaining declaration order among alternatives with the same precedence.
  alternatives.sort((a, b) => Number(b.supplied.some(Boolean)) - Number(a.supplied.some(Boolean)));
  for (const { names, supplied } of alternatives) {
    const values = await Promise.all(names.map((name, index) => supplied[index] ? undefined : credentialFor(name)));
    if (values.every((value, index) => supplied[index] || value !== undefined)) {
      selected = names.map((name, index) => [name, values[index]] as [string, CredentialValue | undefined]);
      break;
    }
  }
  if (!selected) {
    if (evaluation.allowMissing) return config;
    throw new Error("No configured credentials satisfy this operation's security requirements");
  }

  const headers = new AxiosHeaders(config.headers);
  const queries: Record<string, unknown> = Object.assign(Object.create(null), config.queries);
  const cookies: Record<string, string> = Object.assign(Object.create(null), (config as typeof config & { cookies?: Record<string, string> }).cookies);
  for (const [name, credential] of selected) {
    const scheme = security.schemes[name];
    if (!scheme) throw new Error(`Unknown security scheme ${JSON.stringify(name)}`);
    if (credential === undefined) continue;
    if (scheme.type === "apiKey") {
      if (typeof credential !== "string" || !scheme.name) throw new Error(`Invalid API key credential for ${JSON.stringify(name)}`);
      if (scheme.in === "header") {
        if (!headers.has(scheme.name)) headers.set(scheme.name, credential);
      } else if (scheme.in === "query") {
        queries[scheme.name] ??= credential;
      } else if (scheme.in === "cookie") {
        cookies[scheme.name] ??= credential;
      } else throw new Error(`Unsupported API key location for ${JSON.stringify(name)}`);
    } else if (scheme.type === "http" && scheme.scheme?.toLowerCase() === "basic") {
      if (typeof credential !== "object") throw new Error(`Basic credential ${JSON.stringify(name)} requires a username and password`);
      if (!headers.has("Authorization")) headers.set("Authorization", `Basic ${encodeBasic(credential)}`);
    } else if (scheme.type === "oauth2" || scheme.type === "openIdConnect" || (scheme.type === "http" && scheme.scheme?.toLowerCase() === "bearer")) {
      if (typeof credential !== "string") throw new Error(`Bearer credential ${JSON.stringify(name)} must be a string`);
      if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${credential}`);
    } else {
      throw new Error(`Unsupported security scheme ${JSON.stringify(name)}`);
    }
  }
  return { ...config, headers: headers.toJSON(), queries, cookies } as ReadonlyDeep<AnyOtscRequestOptions>;
}
