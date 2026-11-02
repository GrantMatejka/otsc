// disable type checking for this file as we need to defer type checking when using these utility types
// indeed typescript seems to have a bug, where it tries to infer the type of an undecidable generic type
// but when using the functions, types are inferred correctly
import {
  OtscEndpointDefinition,
  OtscEndpointParameter,
  OtscEndpointDefinitions,
  OtscEndpointError,
} from "./otsc.types.js";
import z from "zod";
import * as mini from "zod/mini";
import * as core from "zod/v4/core";
import { capitalize } from "./utils.js";
import { isReservedAlias } from "./aliases.js";
import { Narrow, TupleFlat, UnionToTuple } from "./utils.types.js";

/**
 * check api for non unique paths
 * @param api - api to check
 * @return - nothing
 * @throws - error if api has non unique paths
 */
export function checkApi<T extends OtscEndpointDefinitions>(api: T) {
  // check if no duplicate path
  const paths = new Set<string>();
  for (let endpoint of api) {
    const fullpath = `${endpoint.method} ${endpoint.path}`;
    if (paths.has(fullpath)) {
      throw new Error(`Otsc: Duplicate path '${fullpath}'`);
    }
    paths.add(fullpath);
  }
  // check if no duplicate alias
  const aliases = new Set<string>();
  for (let endpoint of api) {
    if (endpoint.alias) {
      if (isReservedAlias(endpoint.alias)) {
        throw new Error(`Otsc: Reserved alias '${endpoint.alias}'`);
      }
      if (aliases.has(endpoint.alias)) {
        throw new Error(`Otsc: Duplicate alias '${endpoint.alias}'`);
      }
      aliases.add(endpoint.alias);
    }
  }

  // check if no duplicate body in parameters
  for (let endpoint of api) {
    if (endpoint.parameters) {
      const bodyParams = endpoint.parameters.filter((p) => p.type === "Body");
      if (bodyParams.length > 1) {
        throw new Error(
          `Otsc: Multiple body parameters in endpoint '${endpoint.path}'`
        );
      }
    }
  }
}

/**
 * Simple helper to split your api definitions into multiple files
 * Mandatory to be used when declaring your endpoint definitions outside otsc constructor
 * to enable type inferrence and autocompletion
 * @param api - api definitions
 * @returns the api definitions
 */
export function makeApi<const Api extends OtscEndpointDefinitions>(
  api: Api
): Api {
  checkApi(api);
  return api as Api;
}

/**
 * Simple helper to split your parameter definitions into multiple files
 * Mandatory to be used when declaring parameters appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param params - api parameter definitions
 * @returns the api parameter definitions
 */
export function makeParameters<
  ParameterDescriptions extends readonly OtscEndpointParameter[]
>(params: Narrow<ParameterDescriptions>): ParameterDescriptions {
  return params as ParameterDescriptions;
}

export function parametersBuilder() {
  return new ParametersBuilder<[]>([]);
}

type ObjectToQueryParameters<
  Type extends "Query" | "Path" | "Header" | "Cookie",
  T extends Record<string, core.$ZodType>,
  Keys = UnionToTuple<keyof T>
> = {
  [Index in keyof Keys]: {
    name: Keys[Index];
    type: Type;
    description?: string;
    schema: T[Extract<Keys[Index], keyof T>];
  };
};

class ParametersBuilder<T extends readonly OtscEndpointParameter[]> {
  constructor(private params: T) {}

  addParameter<
    Name extends string,
    Type extends "Path" | "Query" | "Body" | "Header" | "Cookie",
    Schema extends core.$ZodType
  >(name: Name, type: Type, schema: Schema) {
    return new ParametersBuilder<
      [...T, { name: Name; type: Type; description?: string; schema: Schema }]
    >([
      ...this.params,
      { name, type, description: core.globalRegistry.get(schema)?.description, schema },
    ]);
  }

  addParameters<
    Type extends "Query" | "Path" | "Header" | "Cookie",
    Schemas extends Record<string, core.$ZodType>
  >(type: Type, schemas: Schemas) {
    const parameters = Object.keys(schemas).map((key) => ({
      name: key,
      type,
      description: core.globalRegistry.get(schemas[key])?.description,
      schema: schemas[key],
    }));
    return new ParametersBuilder<
      [
        ...T,
        ...Extract<
          ObjectToQueryParameters<Type, Schemas>,
          readonly OtscEndpointParameter[]
        >
      ]
    >([...this.params, ...parameters] as any);
  }

  addBody<Schema extends core.$ZodType>(schema: Schema) {
    return this.addParameter("body", "Body", schema);
  }

  addQuery<Name extends string, Schema extends core.$ZodType>(
    name: Name,
    schema: Schema
  ) {
    return this.addParameter(name, "Query", schema);
  }

  addPath<Name extends string, Schema extends core.$ZodType>(
    name: Name,
    schema: Schema
  ) {
    return this.addParameter(name, "Path", schema);
  }

  addHeader<Name extends string, Schema extends core.$ZodType>(
    name: Name,
    schema: Schema
  ) {
    return this.addParameter(name, "Header", schema);
  }

  addCookie<Name extends string, Schema extends core.$ZodType>(name: Name, schema: Schema) {
    return this.addParameter(name, "Cookie", schema);
  }

  addQueries<Schemas extends Record<string, core.$ZodType>>(
    schemas: Schemas
  ) {
    return this.addParameters("Query", schemas);
  }

  addPaths<Schemas extends Record<string, core.$ZodType>>(
    schemas: Schemas
  ) {
    return this.addParameters("Path", schemas);
  }

  addHeaders<Schemas extends Record<string, core.$ZodType>>(
    schemas: Schemas
  ) {
    return this.addParameters("Header", schemas);
  }

  addCookies<Schemas extends Record<string, core.$ZodType>>(schemas: Schemas) {
    return this.addParameters("Cookie", schemas);
  }

  build() {
    return this.params;
  }
}

/**
 * Simple helper to split your error definitions into multiple files
 * Mandatory to be used when declaring errors appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param errors - api error definitions
 * @returns the error definitions
 */
export function makeErrors<ErrorDescription extends readonly OtscEndpointError[]>(
  errors: Narrow<ErrorDescription>
): ErrorDescription {
  return errors as ErrorDescription;
}

/**
 * Simple helper to split your error definitions into multiple files
 * Mandatory to be used when declaring errors appart from your endpoint definitions
 * to enable type inferrence and autocompletion
 * @param endpoint - api endpoint definition
 * @returns the endpoint definition
 */
export function makeEndpoint<T extends OtscEndpointDefinition<any>>(
  endpoint: Narrow<T>
): T {
  return endpoint as T;
}
export class Builder<T extends OtscEndpointDefinitions> {
  constructor(private api: T) {}
  addEndpoint<E extends OtscEndpointDefinition>(
    endpoint: Narrow<E>
  ): Builder<[...T, E]> {
    if (this.api.length === 0) {
      this.api = [endpoint] as unknown as T;
      return this as any;
    }
    this.api = [...this.api, endpoint] as any;
    return this as any;
  }
  build(): T {
    checkApi(this.api!);
    return this.api!;
  }
}

/**
 * Advanced helper to build your api definitions
 * compared to `makeApi()` you'll have better autocompletion experience and better error messages,
 * @param endpoint
 * @returns - a builder to build your api definitions
 */
export function apiBuilder(): Builder<[]>;
export function apiBuilder<T extends OtscEndpointDefinition<any>>(
  endpoint: Narrow<T>
): Builder<[T]>;
export function apiBuilder(endpoint?: any) {
  if (!endpoint) return new Builder([]);
  return new Builder([endpoint]);
}

/**
 * Helper to generate a basic CRUD api for a given resource
 * @param resource - the resource to generate the api for
 * @param schema - the schema of the resource
 * @returns - the api definitions
 */
export function makeCrudApi<
  T extends string,
  S extends z.ZodObject<z.ZodRawShape> | mini.ZodMiniObject
>(resource: T, schema: S) {
  type Schema = z.input<S>;
  const capitalizedResource = capitalize(resource);
  // Classic objects expose instance helpers; Mini objects expose standalone helpers.
  const arraySchema = "partial" in schema ? z.array(schema) : mini.array(schema);
  const partialSchema = "partial" in schema ? schema.partial() : mini.partial(schema);
  return makeApi([
    {
      method: "get",
      // @ts-ignore
      path: `/${resource}s`,
      // @ts-ignore
      alias: `get${capitalizedResource}s`,
      description: `Get all ${resource}s`,
      response: arraySchema,
    },
    {
      method: "get",
      // @ts-ignore
      path: `/${resource}s/:id`,
      // @ts-ignore
      alias: `get${capitalizedResource}`,
      description: `Get a ${resource}`,
      // @ts-ignore
      response: schema,
    },
    {
      method: "post",
      // @ts-ignore
      path: `/${resource}s`,
      // @ts-ignore
      alias: `create${capitalizedResource}`,
      description: `Create a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to create",
          schema: partialSchema as unknown as core.$ZodType<Partial<Schema>, Partial<Schema>>,
        },
      ],
      // @ts-ignore
      response: schema,
    },
    {
      method: "put",
      // @ts-ignore
      path: `/${resource}s/:id`,
      // @ts-ignore
      alias: `update${capitalizedResource}`,
      description: `Update a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to update",
          // @ts-ignore
          schema: schema,
        },
      ],
      // @ts-ignore
      response: schema,
    },
    {
      method: "patch",
      // @ts-ignore
      path: `/${resource}s/:id`,
      // @ts-ignore
      alias: `patch${capitalizedResource}`,
      description: `Patch a ${resource}`,
      parameters: [
        {
          name: "body",
          type: "Body",
          description: "The object to patch",
          schema: partialSchema as unknown as core.$ZodType<Partial<Schema>, Partial<Schema>>,
        },
      ],
      // @ts-ignore
      response: schema,
    },
    {
      method: "delete",
      // @ts-ignore
      path: `/${resource}s/:id`,
      // @ts-ignore
      alias: `delete${capitalizedResource}`,
      description: `Delete a ${resource}`,
      // @ts-ignore
      response: schema,
    },
  ]);
}

type CleanPath<Path extends string> = Path extends `${infer PClean}/`
  ? PClean
  : Path;

type MapApiPath<
  Path extends string,
  Api,
  Acc extends unknown[] = []
> = Api extends readonly [infer Head, ...infer Tail]
  ? MapApiPath<
      Path,
      Tail,
      [
        ...Acc,
        {
          [K in keyof Head]: K extends "path"
            ? Head[K] extends string
              ? CleanPath<`${Path}${Head[K]}`>
              : Head[K]
            : Head[K];
        }
      ]
    >
  : Acc;

type MergeApis<
  Apis extends Record<string, readonly OtscEndpointDefinition[]>,
  MergedPathApis = UnionToTuple<
    {
      [K in keyof Apis]: K extends string ? MapApiPath<K, Apis[K]> : never;
    }[keyof Apis]
  >
> = TupleFlat<MergedPathApis>;

function cleanPath(path: string) {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * prefix all paths of an api with a given prefix
 * @param prefix - the prefix to add
 * @param api - the api to prefix
 * @returns the prefixed api
 */
export function prefixApi<
  Prefix extends string,
  Api extends readonly OtscEndpointDefinition[]
>(prefix: Prefix, api: Api) {
  return api.map((endpoint) => ({
    ...endpoint,
    path: cleanPath(`${prefix}${endpoint.path}`),
  })) as MapApiPath<Prefix, Api>;
}

/**
 * Merge multiple apis into one in a route friendly way
 * @param apis - the apis to merge
 * @returns the merged api
 *
 * @example
 * ```ts
 * const api = mergeApis({
 *   "/users": usersApi,
 *   "/posts": postsApi,
 * });
 * ```
 */
export function mergeApis<
  Apis extends Record<string, readonly OtscEndpointDefinition[]>
>(apis: Apis): MergeApis<Apis> {
  return Object.keys(apis).flatMap((key) => prefixApi(key, apis[key])) as any;
}
