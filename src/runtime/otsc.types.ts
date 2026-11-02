import axios, { AxiosError, AxiosInstance, AxiosResponse } from "axios";
import type {
  FilterArrayByValue,
  MapSchemaParameters,
  ParameterSchemaValue,
  PickDefined,
  NeverIfEmpty,
  UndefinedToOptional,
  PathParamNames,
  SetPropsOptionalIfChildrenAreOptional,
  ReadonlyDeep,
  Merge,
  FilterArrayByKey,
  IfEquals,
  RequiredKeys,
  UndefinedIfNever,
  Simplify,
} from "./utils.types.js";
import type * as z from "zod/v4/core";

type AxiosRequestConfig = Parameters<typeof axios.request>[0];

export type MutationMethod = "post" | "put" | "patch" | "delete";

export type Method = "get" | "head" | "options" | "trace" | "query" | MutationMethod | (string & {});

export type RequestFormat =
  | "json" // default
  | "form-data" // for file uploads
  | "form-url" // for hiding query params in the body
  | "binary" // for binary data / file uploads
  | "text"; // for text data

type EndpointDefinitionsByMethod<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method
> = FilterArrayByValue<Api, { method: M }>;

export type OtscEndpointDefinitionByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = FilterArrayByValue<Api, { method: M; path: Path }>;

export type OtscEndpointDefinitionByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string
> = FilterArrayByValue<Api, { alias: Alias }>;

export type OtscPathsByMethod<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method
> = EndpointDefinitionsByMethod<Api, M>[number]["path"];

export type Aliases<Api extends readonly OtscEndpointDefinition[]> = FilterArrayByKey<
  Api,
  "alias"
>[number]["alias"];

export type OtscResponseForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<Endpoint["response"]>
  : z.input<Endpoint["response"]>;

export type OtscResponseByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<OtscEndpointDefinitionByPath<Api, M, Path>[number]["response"]>
  : z.input<OtscEndpointDefinitionByPath<Api, M, Path>[number]["response"]>;

export type OtscResponseByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<OtscEndpointDefinitionByAlias<Api, Alias>[number]["response"]>
  : z.input<OtscEndpointDefinitionByAlias<Api, Alias>[number]["response"]>;

export type OtscDefaultErrorForEndpoint<
  Endpoint extends OtscEndpointDefinition
> = FilterArrayByValue<
  Endpoint["errors"],
  {
    status: "default";
  }
>[number]["schema"];

type OtscDefaultErrorByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = FilterArrayByValue<
  OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"],
  {
    status: "default";
  }
>[number]["schema"];

type OtscDefaultErrorByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string
> = FilterArrayByValue<
  OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"],
  {
    status: "default";
  }
>[number]["schema"];

type IfNever<E, A> = IfEquals<E, never, A, E>;
type StatusClass<Status extends number> = `${Status}` extends `${infer Group extends 1 | 2 | 3 | 4 | 5}${string}` ? `${Group}XX` : never;

export type OtscErrorForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Status extends number,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<
      IfNever<
        FilterArrayByValue<
          Endpoint["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<Endpoint["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorForEndpoint<Endpoint>>
      >
    >
  : z.input<
      IfNever<
        FilterArrayByValue<
          Endpoint["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<Endpoint["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorForEndpoint<Endpoint>>
      >
    >;

export type OtscErrorByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Status extends number,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<
      IfNever<
        FilterArrayByValue<
          OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorByPath<Api, M, Path>>
      >
    >
  : z.input<
      IfNever<
        FilterArrayByValue<
          OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorByPath<Api, M, Path>>
      >
    >;

export type ErrorsToAxios<T, Acc extends unknown[] = []> = T extends readonly [
  infer Head,
  ...infer Tail
]
  ? Head extends {
      status: infer Status;
      schema: infer Schema;
    }
    ? Schema extends z.$ZodType
      ? ErrorsToAxios<
          Tail,
          [
            ...Acc,
            Merge<
              Omit<AxiosError, "status" | "response">,
              {
                response: Merge<
                  AxiosError<z.input<Schema>>["response"],
                  {
                    status: Status extends number ? Status : number;
                  }
                >;
              }
            >
          ]
        >
      : Acc
    : Acc
  : Acc;

export type OtscMatchingErrorsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = ErrorsToAxios<
  OtscEndpointDefinitionByPath<Api, M, Path>[number]["errors"]
>[number];

export type OtscMatchingErrorsByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string
> = ErrorsToAxios<
  OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"]
>[number];

export type OtscErrorByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Status extends number,
  Frontend extends boolean = true
> = Frontend extends true
  ? z.output<
      IfNever<
        FilterArrayByValue<
          OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorByAlias<Api, Alias>>
      >
    >
  : z.input<
      IfNever<
        FilterArrayByValue<
          OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"],
          {
            status: Status;
          }
        >[number]["schema"],
        IfNever<FilterArrayByValue<OtscEndpointDefinitionByAlias<Api, Alias>[number]["errors"], { status: StatusClass<Status> }>[number]["schema"], OtscDefaultErrorByAlias<Api, Alias>>
      >
    >;

export type BodySchemaForEndpoint<Endpoint extends OtscEndpointDefinition> =
  FilterArrayByValue<
    Endpoint["parameters"],
    { type: "Body" }
  >[number]["schema"];

export type BodySchema<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = FilterArrayByValue<
  OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"],
  { type: "Body" }
>[number]["schema"];

export type OtscBodyForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true
> = ParameterSchemaValue<FilterArrayByValue<Endpoint["parameters"], { type: "Body" }>[number], Frontend>;

export type OtscBodyByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true
> = OtscBodyForEndpoint<OtscEndpointDefinitionByPath<Api, M, Path>[number], Frontend>;

export type BodySchemaByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string
> = FilterArrayByValue<
  OtscEndpointDefinitionByAlias<Api, Alias>[number]["parameters"],
  { type: "Body" }
>[number]["schema"];

export type OtscBodyByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true
> = OtscBodyForEndpoint<OtscEndpointDefinitionByAlias<Api, Alias>[number], Frontend>;

export type OtscQueryParamsForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<Endpoint["parameters"], { type: "Query" }>,
      Frontend
    >
  >
>;

export type OtscQueryParamsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"],
        { type: "Query" }
      >,
      Frontend
    >
  >
>;

export type OtscQueryParamsByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByAlias<Api, Alias>[number]["parameters"],
        { type: "Query" }
      >,
      Frontend
    >
  >
>;

/**
 * @deprecated - use OtscQueryParamsByPath instead
 */
export type OtscPathParams<Path extends string> = NeverIfEmpty<
  Record<PathParamNames<Path>, string | number>
>;

// Generated endpoints carry an authoritative list of path parameters. Their
// transport path can contain mixed segments that the legacy parser cannot split.
type InferredPathParamNames<Endpoint, Path> = Endpoint extends {
  originalPath: string;
  parameters: readonly unknown[];
}
  ? [Extract<Endpoint["parameters"][number], { type: "Path" }>] extends [never]
    ? PathParamNames<Path>
    : never
  : PathParamNames<Path>;

export type OtscPathParamsForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true,
  PathParameters = UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<Endpoint["parameters"], { type: "Path" }>,
      Frontend
    >
  >
> = NeverIfEmpty<
  Simplify<
    Omit<
      {
        [K in InferredPathParamNames<Endpoint, Endpoint["path"]>]: string | number | boolean;
      },
      keyof PathParameters
    > &
      PathParameters
  >
>;

/**
 * Get path params for a given endpoint by path
 */
export type OtscPathParamsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true,
  PathParameters = UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"],
        { type: "Path" }
      >,
      Frontend
    >
  >,
  $PathParamNames extends string = InferredPathParamNames<OtscEndpointDefinitionByPath<Api, M, Path>[number], Path>
> = NeverIfEmpty<
  Simplify<
    Omit<
      {
        [K in $PathParamNames]: string | number | boolean;
      },
      keyof PathParameters
    > &
      PathParameters
  >
>;

/**
 * Get path params for a given endpoint by alias
 */
export type OtscPathParamByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true,
  EndpointDefinition extends OtscEndpointDefinition = OtscEndpointDefinitionByAlias<
    Api,
    Alias
  >[number],
  Path = EndpointDefinition["path"],
  PathParameters = UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<EndpointDefinition["parameters"], { type: "Path" }>,
      Frontend
    >
  >,
  $PathParamNames extends string = InferredPathParamNames<EndpointDefinition, Path>
> = NeverIfEmpty<
  Simplify<
    Omit<
      {
        [K in $PathParamNames]: string | number | boolean;
      },
      keyof PathParameters
    > &
      PathParameters
  >
>;

export type OtscHeaderParamsForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<Endpoint["parameters"], { type: "Header" }>,
      Frontend
    >
  >
>;

export type OtscHeaderParamsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"],
        { type: "Header" }
      >,
      Frontend
    >
  >
>;

export type OtscHeaderParamsByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByAlias<Api, Alias>[number]["parameters"],
        { type: "Header" }
      >,
      Frontend
    >
  >
>;

export type OtscCookieParamsForEndpoint<
  Endpoint extends OtscEndpointDefinition,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<Endpoint["parameters"], { type: "Cookie" }>,
      Frontend
    >
  >
>;

export type OtscCookieParamsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"],
        { type: "Cookie" }
      >,
      Frontend
    >
  >
>;

export type OtscCookieParamsByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string,
  Frontend extends boolean = true
> = NeverIfEmpty<
  UndefinedToOptional<
    MapSchemaParameters<
      FilterArrayByValue<
        OtscEndpointDefinitionByAlias<Api, Alias>[number]["parameters"],
        { type: "Cookie" }
      >,
      Frontend
    >
  >
>;

export type OtscRequestOptionsByAlias<
  Api extends readonly OtscEndpointDefinition[],
  Alias extends string
> = Merge<
  SetPropsOptionalIfChildrenAreOptional<
    PickDefined<{
      params: OtscPathParamByAlias<Api, Alias>;
      queries: OtscQueryParamsByAlias<Api, Alias>;
      headers: OtscHeaderParamsByAlias<Api, Alias>;
      cookies: OtscCookieParamsByAlias<Api, Alias>;
    }>
  >,
  Omit<AxiosRequestConfig, "params" | "data" | "method" | "url">
>;

type RequiredWireValue<Value> = unknown extends Value ? {} | null : Exclude<Value, undefined>;

export type OtscMutationAliasRequest<Body, Config, Response, BodyRequired extends boolean = true> =
  RequiredKeys<Config> extends never
    ? BodyRequired extends false
      ? (body?: ReadonlyDeep<UndefinedIfNever<Body>>, configOptions?: ReadonlyDeep<Config>) => Promise<Response>
      : (
        body: ReadonlyDeep<[Body] extends [never] ? undefined : RequiredWireValue<Body>>,
        configOptions?: ReadonlyDeep<Config>
      ) => Promise<Response>
    : (
        body: ReadonlyDeep<BodyRequired extends true ? [Body] extends [never] ? undefined : RequiredWireValue<Body> : UndefinedIfNever<Body>>,
        configOptions: ReadonlyDeep<Config>
      ) => Promise<Response>;

export type OtscAliasRequest<Config, Response> =
  RequiredKeys<Config> extends never
    ? (configOptions?: ReadonlyDeep<Config>) => Promise<Response>
    : (configOptions: ReadonlyDeep<Config>) => Promise<Response>;

type AliasHasBody<Api extends readonly OtscEndpointDefinition[], Alias extends string> =
  OtscEndpointDefinitionByAlias<Api, Alias>[number] extends { parameters: readonly OtscEndpointParameter[] }
    ? Extract<OtscEndpointDefinitionByAlias<Api, Alias>[number]["parameters"][number], { type: "Body" }> extends never ? false : true
    : false;
type BodyRequiredForEndpoint<Endpoint extends OtscEndpointDefinition> =
  Endpoint extends { requestBodies: readonly unknown[] }
    ? Extract<Endpoint["requestBodies"][number], { required: true }> extends never ? false : true
    : [OtscBodyForEndpoint<Endpoint>] extends [never] ? false : undefined extends OtscBodyForEndpoint<Endpoint> ? false : true;
type AliasBodyRequired<Api extends readonly OtscEndpointDefinition[], Alias extends string> = BodyRequiredForEndpoint<OtscEndpointDefinitionByAlias<Api, Alias>[number]>;

export type OtscBodyMethodArgs<
  Api extends readonly OtscEndpointDefinition[], M extends Method,
  Path extends OtscPathsByMethod<Api, M>, Config
> = Parameters<OtscMutationAliasRequest<OtscBodyByPath<Api, M, Path>, Config, unknown, BodyRequiredForEndpoint<OtscEndpointDefinitionByPath<Api, M, Path>[number]>>>;

export type OtscReadMethodArgs<
  Api extends readonly OtscEndpointDefinition[], M extends Method,
  Path extends OtscPathsByMethod<Api, M>, Config
> = OtscEndpointDefinitionByPath<Api, M, Path>[number] extends { parameters: readonly OtscEndpointParameter[] }
  ? Extract<OtscEndpointDefinitionByPath<Api, M, Path>[number]["parameters"][number], { type: "Body" }> extends never
    ? Parameters<OtscAliasRequest<Config, unknown>>
    : OtscBodyMethodArgs<Api, M, Path, Config>
  : Parameters<OtscAliasRequest<Config, unknown>>;

export type OtscAliases<Api extends readonly OtscEndpointDefinition[]> = {
  [Alias in Aliases<Api>]: OtscEndpointDefinitionByAlias<Api, Alias>[number]["method"] extends MutationMethod
    ? OtscMutationAliasRequest<OtscBodyByAlias<Api, Alias>, OtscRequestOptionsByAlias<Api, Alias>, OtscResponseByAlias<Api, Alias>, AliasBodyRequired<Api, Alias>>
    : AliasHasBody<Api, Alias> extends true
      ? OtscMutationAliasRequest<OtscBodyByAlias<Api, Alias>, OtscRequestOptionsByAlias<Api, Alias>, OtscResponseByAlias<Api, Alias>, AliasBodyRequired<Api, Alias>>
      : OtscAliasRequest<OtscRequestOptionsByAlias<Api, Alias>, OtscResponseByAlias<Api, Alias>>;
};

export type AnyOtscMethodOptions = Merge<
  {
    params?: Record<string, unknown>;
    queries?: Record<string, unknown>;
    cookies?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
  Omit<AxiosRequestConfig, "params" | "headers" | "url" | "method">
>;

export type AnyOtscRequestOptions = Merge<
  { method: Method; url: string },
  AnyOtscMethodOptions
>;

/**
 * @deprecated - use OtscRequestOptionsByPath instead
 */
export type OtscMethodOptions<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = Merge<
  SetPropsOptionalIfChildrenAreOptional<
    PickDefined<{
      params: OtscPathParamsByPath<Api, M, Path>;
      queries: OtscQueryParamsByPath<Api, M, Path>;
      headers: OtscHeaderParamsByPath<Api, M, Path>;
      cookies: OtscCookieParamsByPath<Api, M, Path>;
    }>
  >,
  Omit<AxiosRequestConfig, "params" | "data" | "method" | "url">
>;

/**
 * Get the request options for a given endpoint
 */
export type OtscRequestOptionsByPath<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = Merge<
  SetPropsOptionalIfChildrenAreOptional<
    PickDefined<{
      params: OtscPathParamsByPath<Api, M, Path>;
      queries: OtscQueryParamsByPath<Api, M, Path>;
      headers: OtscHeaderParamsByPath<Api, M, Path>;
      cookies: OtscCookieParamsByPath<Api, M, Path>;
    }>
  >,
  Omit<AxiosRequestConfig, "params" | "data" | "method" | "url">
>;

type RequestDataField<Endpoint extends OtscEndpointDefinition> = Endpoint extends { requestBodies: readonly unknown[] }
  ? Extract<Endpoint["requestBodies"][number], { required: true }> extends never
    ? { data?: OtscBodyForEndpoint<Endpoint> }
    : { data: RequiredWireValue<OtscBodyForEndpoint<Endpoint>> }
  : [OtscBodyForEndpoint<Endpoint>] extends [never]
    ? { data?: never }
    : undefined extends OtscBodyForEndpoint<Endpoint>
      ? { data?: OtscBodyForEndpoint<Endpoint> }
      : { data: RequiredWireValue<OtscBodyForEndpoint<Endpoint>> };

export type OtscRequestOptions<
  Api extends readonly OtscEndpointDefinition[],
  M extends Method,
  Path extends OtscPathsByMethod<Api, M>
> = Merge<
  {
    method: M;
    url: Path;
  } & RequestDataField<OtscEndpointDefinitionByPath<Api, M, Path>[number]>,
  OtscRequestOptionsByPath<Api, M, Path>
>;

/**
 * Otsc options
 */
export type OtscOptions = {
  useOperationServers?: boolean;
  /**
   * Should otsc validate parameters and response? Default: true
   */
  validate?: boolean | "request" | "response" | "all" | "none";
  /**
   * Should otsc transform the request and response ? Default: true
   */
  transform?: boolean | "request" | "response" | "all" | "none";
  /**
   * Should zod schema default values be used on parameters? Default: false
   * you usually want your backend to handle default values
   */
  sendDefaults?: boolean;
  /**
   * Override the default axios instance. Default: otsc will create it's own axios instance
   */
  axiosInstance?: AxiosInstance;
  /**
   * default config for axios requests
   */
  axiosConfig?: AxiosRequestConfig;
  /** Credentials indexed by OpenAPI security scheme name. */
  credentials?: Readonly<Record<string,
    | string
    | { username: string; password: string }
    | (() => string | { username: string; password: string } | undefined | Promise<string | { username: string; password: string } | undefined>)
  >>;
};

export type OtscEndpointParameter<T = unknown> = {
  /**
   * name of the parameter
   */
  name: string;
  /**
   * optional description of the parameter
   */
  description?: string;
  /**
   * type of the parameter: Query, Body, Header, Path, Cookie
   */
  type: "Query" | "Body" | "Header" | "Path" | "Cookie";
  /**
   * zod schema of the parameter
   * you can use zod `transform` to transform the value of the parameter before sending it to the server
   */
  schema: z.$ZodType<T>;
  /** Encode a bidirectional codec from application output to wire input. */
  codecDirection?: "encode";
  /** Serialization metadata for generated OpenAPI parameters. */
  serialization?: {
    in: "path" | "query" | "querystring" | "header" | "cookie";
    name: string;
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
    mediaType?: string;
    contentMediaType?: string;
    encoding?: Readonly<Record<string, { contentType?: string; explode?: boolean; style?: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject" }>>;
    required?: boolean;
  };
};

export type OtscEndpointParameters = readonly OtscEndpointParameter[];

export type OtscEndpointError<T = unknown> = {
  /**
   * status code of the error
   * use 'default' to declare a default error
   */
  status: number | "default" | `${1 | 2 | 3 | 4 | 5}XX`;
  /**
   * description of the error - used to generate the openapi error description
   */
  description?: string;
  /**
   * schema of the error
   */
  schema: z.$ZodType<T>;
};

export type OtscEndpointErrors = readonly OtscEndpointError[];

/**
 * Otsc enpoint definition that should be used to create a new instance of Otsc
 */
export interface OtscEndpointDefinition<R = unknown> {
  server?: string;
  requestBodies?: readonly {
    mediaType: string;
    schema: z.$ZodType;
    required?: boolean;
    encoding?: Readonly<Record<string, { contentType?: string; explode?: boolean; style?: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject" }>>;
  }[];
  /**
   * http method : get, post, put, patch, delete
   */
  method: Method;
  /**
   * path of the endpoint
   * @example
   * ```text
   * /posts/:postId/comments/:commentId
   * ```
   */
  path: string;
  /** Original OpenAPI path template used by generated endpoints. */
  originalPath?: string;
  /** OpenAPI security alternatives; each requirement combines its schemes. */
  security?: readonly Readonly<Record<string, readonly string[]>>[] | {
    requirements: readonly Readonly<Record<string, readonly string[]>>[];
    schemes: Readonly<Record<string, { type: string; in?: string; name?: string; scheme?: string }>>;
  };
  /** Security schemes referenced by this endpoint's requirements. */
  securitySchemes?: Readonly<Record<string, {
    type: string;
    in?: string;
    name?: string;
    scheme?: string;
  }>>;
  /**
   * optional alias to call the endpoint easily
   * @example
   * ```text
   * getPostComments
   * ```
   */
  alias?: string;
  /**
   * optional description of the endpoint
   */
  description?: string;
  /**
   * optional request format of the endpoint: json, form-data, form-url, binary, text
   */
  requestFormat?: RequestFormat;
  /**
   * optionally mark the endpoint as immutable to allow otsc to cache the response with react-query
   * use it to mark a 'post' endpoint as immutable
   */
  immutable?: boolean;
  /**
   * optional parameters of the endpoint
   */
  parameters?: ReadonlyArray<OtscEndpointParameter>;
  /**
   * response of the endpoint
   * you can use zod `transform` to transform the value of the response before returning it
   */
  response: z.$ZodType<R>;
  /** Status and media-specific contracts used when provided. */
  responses?: readonly {
    status: number | "default" | `${1 | 2 | 3 | 4 | 5}XX`;
    mediaType?: string;
    schema: z.$ZodType;
    binary?: boolean;
    stream?: "ndjson" | "json-seq" | "sse" | "binary";
    itemSchema?: z.$ZodType;
  }[];
  /**
   * optional response status of the endpoint for sucess, default is 200
   * customize it if your endpoint returns a different status code and if you need openapi to generate the correct status code
   */
  status?: number;
  /**
   * optional response description of the endpoint
   */
  responseDescription?: string;
  /**
   * optional errors of the endpoint - only usefull when using @otsc/express
   */
  errors?: ReadonlyArray<OtscEndpointError>;
}

export type OtscEndpointDefinitions = readonly OtscEndpointDefinition[];

/**
 * Otsc plugin that can be used to intercept otsc requests and responses
 */
export type OtscPlugin = {
  /**
   * Optional name of the plugin
   * naming a plugin allows to remove it or replace it later
   */
  name?: string;
  /**
   * request interceptor to modify or inspect the request before it is sent
   * @param api - the api description
   * @param request - the request config
   * @returns possibly a new request config
   */
  request?: (
    api: OtscEndpointDefinitions,
    config: ReadonlyDeep<AnyOtscRequestOptions>
  ) => Promise<ReadonlyDeep<AnyOtscRequestOptions>>;
  /**
   * response interceptor to modify or inspect the response before it is returned
   * @param api - the api description
   * @param config - the request config
   * @param response - the response
   * @returns possibly a new response
   */
  response?: (
    api: OtscEndpointDefinitions,
    config: ReadonlyDeep<AnyOtscRequestOptions>,
    response: AxiosResponse
  ) => Promise<AxiosResponse>;
  /**
   * error interceptor for response errors
   * there is no error interceptor for request errors
   * @param api - the api description
   * @param config - the config for the request
   * @param error - the error that occured
   * @returns possibly a new response or a new error
   */
  error?: (
    api: OtscEndpointDefinitions,
    config: ReadonlyDeep<AnyOtscRequestOptions>,
    error: Error
  ) => Promise<AxiosResponse>;
};
