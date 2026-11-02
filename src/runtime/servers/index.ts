/** A variable used in a server URL template. Values are substituted verbatim. */
export interface ServerVariable {
  readonly default: string;
  readonly enum?: readonly string[];
  readonly description?: string;
}

/** A server URL and the variables available to its template. */
export interface Server {
  readonly url: string;
  readonly variables?: Readonly<Record<string, ServerVariable>>;
  readonly description?: string;
}

export type ServerDefinition = string | Server;
export type ServerVariables = Readonly<Record<string, string>>;

export interface ServerSelectionOptions {
  /** Zero-based server index. Defaults to the first server. */
  readonly index?: number;
  readonly variables?: ServerVariables;
  /** Optional absolute base for resolving relative server URLs. */
  readonly baseUrl?: string;
}

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Substitute a server's template variables, using overrides before defaults.
 * Values are inserted verbatim so callers can supply URL components such as
 * hostnames, ports and paths. No implicit URL encoding is applied.
 */
export function substituteServerVariables(
  server: ServerDefinition,
  overrides: ServerVariables = {},
): string {
  const template = typeof server === "string" ? server : server.url;
  const variables = typeof server === "string" ? undefined : server.variables;
  if (typeof template !== "string") throw new Error("Server URL must be a string");

  // Validate the template itself, not the expanded URL: variable values are
  // inserted verbatim and may legitimately contain braces.
  if (/[{}]/.test(template.replace(/\{([^{}]+)\}/g, ""))) {
    throw new Error("Server URL contains an invalid variable template");
  }
  return template.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const variable = variables && hasOwn(variables, name) ? variables[name] : undefined;
    if (!variable || typeof variable.default !== "string") {
      throw new Error(`Server variable ${JSON.stringify(name)} requires a string default`);
    }
    const value = hasOwn(overrides, name) ? overrides[name] : variable.default;
    if (typeof value !== "string") {
      throw new Error(`Server variable ${JSON.stringify(name)} must be a string`);
    }
    if (variable.enum && !variable.enum.includes(value)) {
      throw new Error(`Value for server variable ${JSON.stringify(name)} is not in its enum`);
    }
    return value;
  });
}

/**
 * Select and expand a server. Without a base, relative URLs are returned as-is;
 * with a base, the platform URL implementation resolves them consistently in
 * browsers and Node. An empty list has no selected server.
 */
export function selectServer(
  servers: readonly ServerDefinition[],
  options: ServerSelectionOptions = {},
): string | undefined {
  const index = options.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || (servers.length > 0 && index >= servers.length)) {
    throw new RangeError(`Server index ${index} is out of range`);
  }
  if (servers.length === 0) {
    if (index !== 0) throw new RangeError(`Server index ${index} is out of range`);
    return undefined;
  }
  const url = substituteServerVariables(servers[index]!, options.variables);
  if (options.baseUrl === undefined) return url;
  try {
    return new URL(url, options.baseUrl).href;
  } catch {
    throw new TypeError(`Cannot resolve server URL ${JSON.stringify(url)} against the supplied base URL`);
  }
}
