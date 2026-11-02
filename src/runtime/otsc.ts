import axios, { AxiosHeaders } from "axios";
import type { AxiosInstance } from "axios";
import {
  AnyOtscRequestOptions,
  OtscRequestOptions,
  OtscBodyByPath,
  Method,
  OtscPathsByMethod,
  OtscResponseByPath,
  OtscOptions,
  OtscEndpointDefinitions,
  OtscRequestOptionsByPath,
  OtscAliases,
  OtscReadMethodArgs,
  OtscBodyMethodArgs,
  OtscPlugin,
  Aliases,
} from "./otsc.types.js";
import { findEndpoint, omit } from "./utils.js";
import { prepareWireRequest } from "./wire.js";
import { applySecurity, hasDeclaredCredentialParameter } from "./security.js";
import { selectRequestBody } from "./request-body.js";
import { encodeRequestBody } from "./body/index.js";
import { bufferStreamResponse, decodeBufferedResponse, findResponseContract, responseContentType } from "./response.js";
import { decodeStreamResponse } from "./stream-response.js";
import { isBinaryMediaType } from "./media.js";
import { defaultRequestHeaders } from "./headers.js";
import {
  PluginId,
  OtscPlugins,
  zodValidationPlugin,
  formDataPlugin,
  formURLPlugin,
  headerPlugin,
} from "./plugins/index.js";
import {
  Narrow,
  PickRequired,
  ReadonlyDeep,
  RequiredKeys,
  UndefinedIfNever,
} from "./utils.types.js";
import { checkApi } from "./api.js";

function usesDefaultResponseTransforms(transforms: unknown): boolean {
  const actual = Array.isArray(transforms) ? transforms : [transforms];
  const standard = Array.isArray(axios.defaults.transformResponse)
    ? axios.defaults.transformResponse
    : [axios.defaults.transformResponse];
  return actual.length === standard.length && actual.every((transform, index) => transform === standard[index]);
}

/**
 * otsc api client based on axios
 */
export class OtscClass<Api extends OtscEndpointDefinitions> {
  private axiosInstance: AxiosInstance;
  private clientBaseURL?: string;
  public readonly options: PickRequired<
    OtscOptions,
    "validate" | "transform" | "sendDefaults"
  >;
  public readonly api: Api;
  private endpointPlugins: Map<string, OtscPlugins> = new Map();

  /**
   * constructor
   * @param baseURL - the base url to use - if omited will use the browser domain
   * @param api - the description of all the api endpoints
   * @param options - the options to setup the client API
   * @example
   *   const apiClient = new Otsc("https://jsonplaceholder.typicode.com", [
   *     {
   *       method: "get",
   *       path: "/users",
   *       description: "Get all users",
   *       parameters: [
   *         {
   *           name: "q",
   *           type: "Query",
   *           schema: z.string(),
   *         },
   *         {
   *           name: "page",
   *           type: "Query",
   *           schema: z.string().optional(),
   *         },
   *       ],
   *       response: z.array(z.object({ id: z.number(), name: z.string() })),
   *     }
   *   ]);
   */
  constructor(api: Narrow<Api>, options?: OtscOptions);
  constructor(baseUrl: string, api: Narrow<Api>, options?: OtscOptions);
  constructor(
    arg1?: Api | string,
    arg2?: Api | OtscOptions,
    arg3?: OtscOptions
  ) {
    let options: OtscOptions;
    if (arg1 === undefined || arg1 === null) {
      if (Array.isArray(arg2)) {
        throw new Error("Otsc: missing base url");
      }
      throw new Error("Otsc: missing api description");
    }
    let baseURL: string | undefined;
    if (typeof arg1 === "string" && Array.isArray(arg2)) {
      baseURL = arg1;
      this.api = arg2 as Api;
      options = arg3 || {};
    } else if (Array.isArray(arg1) && !Array.isArray(arg2)) {
      this.api = arg1 as Api;
      options = (arg2 || {}) as OtscOptions;
    } else {
      throw new Error("Otsc: api must be an array");
    }

    checkApi(this.api);

    this.options = {
      validate: true,
      transform: true,
      sendDefaults: false,
      ...options,
    };

    if (this.options.axiosInstance) {
      this.axiosInstance = this.options.axiosInstance;
    } else {
      this.axiosInstance = axios.create({
        ...this.options.axiosConfig,
      });
    }
    this.clientBaseURL = baseURL;

    this.injectAliasEndpoints();
    this.initPlugins();
    if ([true, "all", "request", "response"].includes(this.options.validate)) {
      this.use(zodValidationPlugin({ ...this.options, getDefaultHeaders: () => this.axiosInstance.defaults.headers, getDefaultAuth: () => this.axiosInstance.defaults.auth }));
    }
  }

  private initPlugins() {
    this.endpointPlugins.set("any-any", new OtscPlugins("any", "any"));

    this.api.forEach((endpoint) => {
      const plugins = new OtscPlugins(endpoint.method, endpoint.path);
      switch (endpoint.requestBodies?.length ? undefined : endpoint.requestFormat) {
        case "binary":
          plugins.use(headerPlugin("Content-Type", "application/octet-stream"));
          break;
        case "form-data":
          plugins.use(formDataPlugin());
          break;
        case "form-url":
          plugins.use(formURLPlugin());
          break;
        case "text":
          plugins.use(headerPlugin("Content-Type", "text/plain"));
          break;
      }
      this.endpointPlugins.set(`${endpoint.method}-${endpoint.path}`, plugins);
    });
  }

  private getAnyEndpointPlugins() {
    return this.endpointPlugins.get("any-any");
  }

  private findAliasEndpointPlugins(alias: string) {
    const endpoint = this.api.find((endpoint) => endpoint.alias === alias);
    if (endpoint) {
      return this.endpointPlugins.get(`${endpoint.method}-${endpoint.path}`);
    }
    return undefined;
  }

  private findEnpointPlugins(method: Method, path: string) {
    return this.endpointPlugins.get(`${method}-${path}`);
  }

  /**
   * get the base url of the api
   */
  get baseURL() {
    return this.clientBaseURL ?? this.axiosInstance.defaults.baseURL;
  }

  /**
   * get the underlying axios instance
   */
  get axios() {
    return this.axiosInstance;
  }

  /**
   * register a plugin to intercept the requests or responses
   * @param plugin - the plugin to use
   * @returns an id to allow you to unregister the plugin
   */
  use(plugin: OtscPlugin): PluginId;
  use<Alias extends Aliases<Api>>(alias: Alias, plugin: OtscPlugin): PluginId;
  use<M extends Method, Path extends OtscPathsByMethod<Api, M>>(
    method: M,
    path: Path,
    plugin: OtscPlugin
  ): PluginId;
  use(...args: unknown[]) {
    if (typeof args[0] === "object") {
      const plugins = this.getAnyEndpointPlugins()!;
      return plugins.use(args[0] as OtscPlugin);
    } else if (typeof args[0] === "string" && typeof args[1] === "object") {
      const plugins = this.findAliasEndpointPlugins(args[0]);
      if (!plugins)
        throw new Error(
          `Otsc: no alias '${args[0]}' found to register plugin`
        );
      return plugins.use(args[1] as OtscPlugin);
    } else if (
      typeof args[0] === "string" &&
      typeof args[1] === "string" &&
      typeof args[2] === "object"
    ) {
      const plugins = this.findEnpointPlugins(args[0] as Method, args[1]);
      if (!plugins)
        throw new Error(
          `Otsc: no endpoint '${args[0]} ${args[1]}' found to register plugin`
        );
      return plugins.use(args[2] as OtscPlugin);
    }
    throw new Error("Otsc: invalid plugin registration");
  }

  /**
   * unregister a plugin
   * if the plugin name is provided instead of the registration plugin id,
   * it will unregister the plugin with that name only for non endpoint plugins
   * @param plugin - id of the plugin to remove
   */
  eject(plugin: PluginId | string): void {
    if (typeof plugin === "string") {
      const plugins = this.getAnyEndpointPlugins()!;
      plugins.eject(plugin);
      return;
    }
    this.endpointPlugins.get(plugin.key)?.eject(plugin);
  }

  private injectAliasEndpoints() {
    this.api.forEach((endpoint) => {
      if (endpoint.alias) {
        if (["post", "put", "patch", "delete"].includes(endpoint.method) || endpoint.parameters?.some((parameter) => parameter.type === "Body")) {
          (this as any)[endpoint.alias] = (data: any, config: any) =>
            this.request({
              ...(config as object | undefined),
              method: endpoint.method,
              url: endpoint.path,
              data,
            } as any);
        } else {
          (this as any)[endpoint.alias] = (config: any) =>
            this.request({
              ...(config as object | undefined),
              method: endpoint.method,
              url: endpoint.path,
            } as any);
        }
      }
    });
  }

  /**
   * make a request to the api
   * @param config - the config to setup otsc options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async request<M extends Method, Path extends string>(
    config: Path extends OtscPathsByMethod<Api, M>
      ? ReadonlyDeep<OtscRequestOptions<Api, M, Path>>
      : ReadonlyDeep<OtscRequestOptions<Api, M, OtscPathsByMethod<Api, M>>>
  ): Promise<
    OtscResponseByPath<
      Api,
      M,
      Path extends OtscPathsByMethod<Api, M> ? Path : never
    >
  > {
    let conf = config as unknown as ReadonlyDeep<AnyOtscRequestOptions>;
    let endpoint = findEndpoint(this.api, conf.method, conf.url);
    const credentialCache = new Map();
    if (hasDeclaredCredentialParameter(endpoint)) conf = await applySecurity(endpoint, this.options, conf, { allowMissing: true, cache: credentialCache, defaultHeaders: defaultRequestHeaders(this.axiosInstance.defaults.headers, conf.method), defaultAuth: this.axiosInstance.defaults.auth });
    const anyPlugin = this.getAnyEndpointPlugins()!;
    const endpointPlugin = this.findEnpointPlugins(conf.method, conf.url);
    conf = await anyPlugin.interceptRequest(this.api, conf);
    if (endpointPlugin) {
      conf = await endpointPlugin.interceptRequest(this.api, conf);
    }
    endpoint = findEndpoint(this.api, conf.method, conf.url);
    conf = await applySecurity(endpoint, this.options, conf, { cache: credentialCache, defaultHeaders: defaultRequestHeaders(this.axiosInstance.defaults.headers, conf.method), defaultAuth: this.axiosInstance.defaults.auth });
    if (conf.data !== undefined && ["get", "head"].includes(conf.method.toLowerCase()) && (typeof process === "undefined" || !process.versions?.node)) {
      throw new Error(`${conf.method.toUpperCase()} request bodies are not supported by browser transports`);
    }
    const wantsStream = endpoint?.responses?.some((contract) => contract.stream) ?? false;
    const autoStream = wantsStream && conf.responseType === undefined && this.axiosInstance.defaults.responseType === undefined &&
      conf.transformResponse === undefined && usesDefaultResponseTransforms(this.axiosInstance.defaults.transformResponse);
    if (autoStream) {
      conf = { ...conf, responseType: "stream" };
    }
    const bufferResponses = conf.responseType === undefined &&
      conf.transformResponse === undefined &&
      this.axiosInstance.defaults.responseType === undefined &&
      usesDefaultResponseTransforms(this.axiosInstance.defaults.transformResponse) &&
      endpoint?.responses?.some((contract) => contract.binary || isBinaryMediaType(contract.mediaType)) === true;
    if (bufferResponses) conf = { ...conf, responseType: "arraybuffer" };
    const textResponses = (
      endpoint?.responses?.some((contract) => { const media = contract.mediaType?.split(";", 1)[0]?.trim().toLowerCase(); return media?.startsWith("text/") || media === "application/xml" || media?.endsWith("+xml"); }) &&
      conf.responseType === undefined &&
      conf.transformResponse === undefined &&
      this.axiosInstance.defaults.responseType === undefined &&
      usesDefaultResponseTransforms(this.axiosInstance.defaults.transformResponse)
    );
    if (textResponses) conf = { ...conf, responseType: "text" };
    const wire = prepareWireRequest(endpoint, conf);
    const effectiveHeaders = AxiosHeaders.concat(defaultRequestHeaders(this.axiosInstance.defaults.headers, conf.method), conf.headers);
    const bodyContract = conf.data === undefined ? undefined : selectRequestBody(endpoint, effectiveHeaders);
    let requestData = conf.data;
    let requestHeaders = "headers" in wire ? wire.headers : conf.headers;
    if (bodyContract) {
      const headers = new AxiosHeaders(requestHeaders);
      const contentType = headers.get("Content-Type") ?? effectiveHeaders.get("Content-Type");
      const encoded = encodeRequestBody(conf.data, {
        mediaType: typeof contentType === "string" ? contentType : bodyContract.mediaType,
        encoding: bodyContract.encoding,
      });
      requestData = encoded.data;
      headers.set(encoded.headers);
      if (encoded.removeContentType) headers.set("Content-Type", undefined, true);
      else if (contentType === null || contentType === false) headers.set("Content-Type", contentType, true);
      requestHeaders = headers;
    }
    let response = this.axiosInstance.request<any, any, any, any>({
      ...omit(conf as AnyOtscRequestOptions, ["params", "queries", "cookies"] as (keyof AnyOtscRequestOptions)[]),
      baseURL: conf.baseURL ?? (this.options.useOperationServers ? endpoint?.server : undefined) ?? this.clientBaseURL,
      ...wire,
      params: conf.queries,
      data: requestData,
      headers: requestHeaders,
    });
    if (endpoint) {
      const decodeResponse = (result: any) => {
        const decodeText = !!textResponses || (!!endpoint.responses &&
          conf.transformResponse === undefined && usesDefaultResponseTransforms(this.axiosInstance.defaults.transformResponse) &&
          (result.config?.responseType ?? conf.responseType ?? this.axiosInstance.defaults.responseType) === "text");
        if (bufferResponses || decodeText || result.status === 204 || result.status === 205 || endpoint.method.toLowerCase() === "head") {
          decodeBufferedResponse(endpoint, conf, result, decodeText);
        }
      };
      response = response.then(
        async (result: any) => {
          const contract = findResponseContract(endpoint, result.status, responseContentType(result.headers));
          if (autoStream && !contract?.stream) await bufferStreamResponse(endpoint, { ...conf, maxContentLength: result.config?.maxContentLength ?? conf.maxContentLength }, result);
          else if (!contract?.stream) decodeResponse(result);
          return result;
        },
        async (error: any) => {
          if (error?.response) {
            const contract = findResponseContract(endpoint, error.response.status, responseContentType(error.response.headers));
            if (contract?.stream) error.response.data = decodeStreamResponse(error.response.data, contract.stream, contract.itemSchema, {
              validate: [true, "response", "all"].includes(this.options.validate),
              transform: [true, "response", "all"].includes(this.options.transform),
              signal: conf.signal as AbortSignal | undefined,
            });
            else if (autoStream) await bufferStreamResponse(endpoint, { ...conf, maxContentLength: error.response.config?.maxContentLength ?? conf.maxContentLength }, error.response);
            else decodeResponse(error.response);
          }
          throw error;
        },
      );
    }
    if (endpointPlugin) {
      response = endpointPlugin.interceptResponse(this.api, conf, response);
    }
    response = anyPlugin.interceptResponse(this.api, conf, response);
    const result = await response;
    const contract = endpoint && findResponseContract(endpoint, result.status, responseContentType(result.headers));
    if (contract?.stream && result.status !== 204 && result.status !== 205 && endpoint?.method !== "head") {
      return decodeStreamResponse(result.data, contract.stream, contract.itemSchema, {
        validate: [true, "response", "all"].includes(this.options.validate),
        transform: [true, "response", "all"].includes(this.options.transform),
        signal: conf.signal as AbortSignal | undefined,
      }) as OtscResponseByPath<Api, M, Path extends OtscPathsByMethod<Api, M> ? Path : never>;
    }
    return result.data;
  }

  private requestReadMethod(method: Method, path: string, args: readonly unknown[]): Promise<any> {
    const hasBody = findEndpoint(this.api, method, path)?.parameters?.some(parameter => parameter.type === "Body") ?? false;
    const config = hasBody ? args[1] : args[0];
    return this.request({ ...(config as object | undefined), method, url: path, ...(hasBody ? { data: args[0] } : {}) } as any);
  }

  /**
   * make a get request to the api
   * @param path - the path to api endpoint
   * @param config - the config to setup axios options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async get<
    Path extends OtscPathsByMethod<Api, "get">,
    TConfig extends OtscRequestOptionsByPath<Api, "get", Path>
  >(
    path: Path,
    ...args: OtscReadMethodArgs<Api, "get", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "get", Path>> {
    return this.requestReadMethod("get", path, args);
  }

  /** Make a HEAD request to a declared endpoint. */
  async head<
    Path extends OtscPathsByMethod<Api, "head">,
    TConfig extends OtscRequestOptionsByPath<Api, "head", Path>
  >(
    path: Path,
    ...args: OtscReadMethodArgs<Api, "head", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "head", Path>> {
    return this.requestReadMethod("head", path, args);
  }

  /** Make a TRACE request to a declared endpoint. */
  async trace<
    Path extends OtscPathsByMethod<Api, "trace">,
    TConfig extends OtscRequestOptionsByPath<Api, "trace", Path>
  >(
    path: Path,
    ...args: OtscReadMethodArgs<Api, "trace", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "trace", Path>> {
    return this.requestReadMethod("trace", path, args);
  }

  /** Make a QUERY request to a declared endpoint. */
  async query<
    Path extends OtscPathsByMethod<Api, "query">,
    TConfig extends OtscRequestOptionsByPath<Api, "query", Path>
  >(
    path: Path,
    ...args: OtscReadMethodArgs<Api, "query", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "query", Path>> {
    return this.requestReadMethod("query", path, args);
  }

  /** Make an OPTIONS request to a declared endpoint. */
  async httpOptions<
    Path extends OtscPathsByMethod<Api, "options">,
    TConfig extends OtscRequestOptionsByPath<Api, "options", Path>
  >(
    path: Path,
    ...args: OtscReadMethodArgs<Api, "options", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "options", Path>> {
    return this.requestReadMethod("options", path, args);
  }

  /**
   * make a post request to the api
   * @param path - the path to api endpoint
   * @param data - the data to send
   * @param config - the config to setup axios options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async post<
    Path extends OtscPathsByMethod<Api, "post">,
    TConfig extends OtscRequestOptionsByPath<Api, "post", Path>
  >(
    path: Path,
    ...args: OtscBodyMethodArgs<Api, "post", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "post", Path>> {
    const [data, config] = args;
    return this.request({
      ...(config as object | undefined),
      method: "post",
      url: path,
      data,
    } as any);
  }

  /**
   * make a put request to the api
   * @param path - the path to api endpoint
   * @param data - the data to send
   * @param config - the config to setup axios options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async put<
    Path extends OtscPathsByMethod<Api, "put">,
    TConfig extends OtscRequestOptionsByPath<Api, "put", Path>
  >(
    path: Path,
    ...args: OtscBodyMethodArgs<Api, "put", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "put", Path>> {
    const [data, config] = args;
    return this.request({
      ...(config as object | undefined),
      method: "put",
      url: path,
      data,
    } as any);
  }

  /**
   * make a patch request to the api
   * @param path - the path to api endpoint
   * @param data - the data to send
   * @param config - the config to setup axios options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async patch<
    Path extends OtscPathsByMethod<Api, "patch">,
    TConfig extends OtscRequestOptionsByPath<Api, "patch", Path>
  >(
    path: Path,
    ...args: OtscBodyMethodArgs<Api, "patch", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "patch", Path>> {
    const [data, config] = args;
    return this.request({
      ...(config as object | undefined),
      method: "patch",
      url: path,
      data,
    } as any);
  }

  /**
   * make a delete request to the api
   * @param path - the path to api endpoint
   * @param config - the config to setup axios options and parameters
   * @returns response validated with zod schema provided in the api description
   */
  async delete<
    Path extends OtscPathsByMethod<Api, "delete">,
    TConfig extends OtscRequestOptionsByPath<Api, "delete", Path>
  >(
    path: Path,
    ...args: OtscBodyMethodArgs<Api, "delete", Path, TConfig>
  ): Promise<OtscResponseByPath<Api, "delete", Path>> {
    const [data, config] = args;
    return this.request({
      ...(config as object | undefined),
      method: "delete",
      url: path,
      data,
    } as any);
  }
}

export type OtscInstance<Api extends OtscEndpointDefinitions> =
  OtscClass<Api> & OtscAliases<Api>;

export type OtscConstructor = {
  new <const Api extends OtscEndpointDefinitions>(
    api: Api,
    options?: OtscOptions
  ): OtscInstance<Api>;
  new <const Api extends OtscEndpointDefinitions>(
    baseUrl: string,
    api: Api,
    options?: OtscOptions
  ): OtscInstance<Api>;
};

export const Otsc = OtscClass as OtscConstructor;

/**
 * Get the Api description type from otsc
 * @param Z - otsc type
 */
export type ApiOf<Z> = Z extends OtscInstance<infer Api> ? Api : never;
