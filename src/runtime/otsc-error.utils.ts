import { $ZodAsyncError, safeParse } from "zod/v4/core";
import { AxiosError } from "axios";
import { findEndpointErrorsByAlias, findEndpointErrorsByPath } from "./utils.js";
import {
  Aliases,
  Method,
  OtscEndpointDefinitions,
  OtscEndpointError,
  OtscMatchingErrorsByAlias,
  OtscMatchingErrorsByPath,
  OtscPathsByMethod,
} from "./otsc.types.js";

function isDefinedError(
  error: unknown,
  findEndpointErrors: (error: AxiosError) => readonly OtscEndpointError[] | undefined
): boolean {
  if (
    error instanceof AxiosError ||
    (error && typeof error === "object" && "isAxiosError" in error)
  ) {
    const err = error as AxiosError;
    if (err.response) {
      const endpointErrors = findEndpointErrors(err);
      if (endpointErrors) {
        return endpointErrors.some(
          (desc) => {
            try {
              return safeParse(desc.schema, err.response!.data).success;
            } catch (cause) {
              if (cause instanceof $ZodAsyncError) return false;
              throw cause;
            }
          }
        );
      }
    }
  }
  return false;
}

/**
 * check if the error is matching the endpoint errors definitions
 * @param api - the api definition
 * @param method - http method of the endpoint
 * @param path - path of the endpoint
 * @param error - the error to check
 * @returns - if true, the error type is narrowed to the matching endpoint errors
 */
export function isErrorFromPath<
  Api extends OtscEndpointDefinitions,
  M extends Method,
  Path extends string
>(
  api: Api,
  method: M,
  path: Path extends OtscPathsByMethod<Api, M>
    ? Path
    : OtscPathsByMethod<Api, M>,
  error: unknown
): error is OtscMatchingErrorsByPath<
  Api,
  M,
  Path extends OtscPathsByMethod<Api, M> ? Path : never
> {
  return isDefinedError(error, (err) =>
    findEndpointErrorsByPath(api, method, path, err)
  );
}

/**
 * check if the error is matching the endpoint errors definitions
 * @param api - the api definition
 * @param alias - alias of the endpoint
 * @param error - the error to check
 * @returns - if true, the error type is narrowed to the matching endpoint errors
 */
export function isErrorFromAlias<
  Api extends OtscEndpointDefinitions,
  Alias extends string
>(
  api: Api,
  alias: Alias extends Aliases<Api> ? Alias : Aliases<Api>,
  error: unknown
): error is OtscMatchingErrorsByAlias<Api, Alias> {
  return isDefinedError(error, (err) =>
    findEndpointErrorsByAlias(api, alias, err)
  );
}
