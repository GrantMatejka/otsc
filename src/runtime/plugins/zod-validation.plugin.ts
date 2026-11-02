import { safeEncodeAsync, safeParseAsync } from "zod/v4/core";
import { AxiosHeaders, type AxiosInstance } from "axios";
import { OtscError } from "../otsc-error.js";
import type { OtscOptions, OtscPlugin } from "../otsc.types.js";
import { findEndpoint } from "../utils.js";
import { selectRequestBody } from "../request-body.js";
import { findResponseContract, responseContentType } from "../response.js";
import { encodeBasic } from "../security.js";
import { defaultRequestHeaders } from "../headers.js";

type Options = Required<
  Pick<OtscOptions, "validate" | "transform" | "sendDefaults">
> & { getDefaultHeaders?: () => AxiosInstance["defaults"]["headers"]; getDefaultAuth?: () => AxiosInstance["defaults"]["auth"] };

function shouldResponse(option: string | boolean) {
  return [true, "response", "all"].includes(option);
}

function shouldRequest(option: string | boolean) {
  return [true, "request", "all"].includes(option);
}

/**
 * Zod validation plugin used internally by Otsc.
 * By default otsc always validates the response.
 * @returns zod-validation plugin
 */
export function zodValidationPlugin({
  validate,
  transform,
  sendDefaults,
  getDefaultHeaders,
  getDefaultAuth,
}: Options): OtscPlugin {
  return {
    name: "zod-validation",
    request: shouldRequest(validate)
      ? async (api, config) => {
          const endpoint = findEndpoint(api, config.method, config.url);
          if (!endpoint) {
            throw new Error(
              `No endpoint found for ${config.method} ${config.url}`
            );
          }
          const { parameters } = endpoint;
          if (!parameters) {
            return config;
          }
          const conf = {
            ...config,
            queries: {
              ...config.queries,
            },
            headers: {
              ...config.headers,
            },
            cookies: {
              ...config.cookies,
            },
            params: {
              ...config.params,
            },
          };
          const defaultHeaders = defaultRequestHeaders(getDefaultHeaders?.(), config.method);
          const headerKey = (name: string) => Object.keys(conf.headers).find((key) => key.toLowerCase() === name.toLowerCase());
          const paramsOf = {
            Query: (name: string) => conf.queries?.[name],
            Body: (_: string) => conf.data,
            Header: (name: string) => {
              const auth = config.auth ?? getDefaultAuth?.();
              if (name.toLowerCase() === "authorization" && auth) return `Basic ${encodeBasic(auth)}`;
              const key = headerKey(name);
              if (key !== undefined) return conf.headers?.[key];
              const value = defaultHeaders.get(name);
              if (value !== undefined) return value;
              return undefined;
            },
            Cookie: (name: string) => conf.cookies?.[name],
            Path: (name: string) => conf.params?.[name],
          };
          const setParamsOf = {
            Query: (name: string, value: any) => (conf.queries![name] = value),
            Body: (_: string, value: any) => (conf.data = value),
            Header: (name: string, value: any) => (conf.headers![headerKey(name) ?? name] = value),
            Cookie: (name: string, value: any) => (conf.cookies![name] = value),
            Path: (name: string, value: any) => (conf.params![name] = value),
          };
          const transformRequest = shouldRequest(transform);
          for (const parameter of parameters) {
            const { name, type } = parameter;
            const value = paramsOf[type](name);
            const bodyRequired = type === "Body" && endpoint.requestBodies?.some((contract) => contract.required);
            if (value === undefined && bodyRequired) {
              throw new OtscError(`Otsc: Missing required Body parameter '${name}'`, config, value);
            }
            const bodyContract = type === "Body" && value !== undefined ? selectRequestBody(endpoint, AxiosHeaders.concat(defaultHeaders, conf.headers)) : undefined;
            const schema = bodyContract?.schema ?? parameter.schema;
            if (value === undefined && parameter.serialization?.required) {
              throw new OtscError(`Otsc: Missing required ${type} parameter '${name}'`, config, value);
            }
            if (sendDefaults || value !== undefined) {
              const parsed = await (parameter.codecDirection === "encode"
                ? safeEncodeAsync(schema, value)
                : safeParseAsync(schema, value));
              if (!parsed.success) {
                throw new OtscError(
                  `Otsc: Invalid ${type} parameter '${name}'`,
                  config,
                  value,
                  parsed.error
                );
              }
              if (transformRequest) {
                setParamsOf[type](name, parsed.data);
              }
            }
          }
          return conf;
        }
      : undefined,
    response: shouldResponse(validate)
      ? async (api, config, response) => {
          const endpoint = findEndpoint(api, config.method, config.url);
          /* istanbul ignore next */
          if (!endpoint) {
            throw new Error(
              `No endpoint found for ${config.method} ${config.url}`
            );
          }
          // JSON text decoding is specific to status/media contracts.
          const emptyBody = response.status === 204 || response.status === 205 || endpoint.method.toLowerCase() === "head";
          if (emptyBody) response.data = undefined;
          if (endpoint.responses) {
            const contentType = responseContentType(response.headers);
            const contract = findResponseContract(endpoint, response.status, contentType);
            if (contract?.stream && !emptyBody) return response;
            const schema = contract?.schema;
            if (!schema) throw new Error(`Otsc: No response contract for ${response.status} ${String(contentType ?? "")}`);
            const parsed = await safeParseAsync(schema, response.data);
            if (!parsed.success) throw new OtscError(`Otsc: Invalid response from endpoint '${endpoint.method} ${endpoint.path}'`, config, response.data, parsed.error);
            if (shouldResponse(transform)) response.data = parsed.data;
            return response;
          }
          const contentType = responseContentType(response.headers);
          if (emptyBody || (typeof contentType === "string" && (
            contentType.includes("application/json") ||
            contentType.includes("application/vnd.api+json")
          ))) {
            const parsed = await safeParseAsync(endpoint.response, response.data);
            if (!parsed.success) {
              throw new OtscError(
                `Otsc: Invalid response from endpoint '${endpoint.method} ${
                  endpoint.path
                }'\nstatus: ${response.status} ${
                  response.statusText
                }\ncause:\n${parsed.error.message}\nreceived:\n${JSON.stringify(
                  response.data,
                  null,
                  2
                )}`,
                config,
                response.data,
                parsed.error
              );
            }
            if (shouldResponse(transform)) {
              response.data = parsed.data;
            }
          }
          return response;
        }
      : undefined,
    error: shouldResponse(validate)
      ? async (api, config, error) => {
          const endpoint = findEndpoint(api, config.method, config.url);
          const response = (error as { response?: { status: number; headers?: Record<string, unknown>; data: unknown; config?: { responseType?: string } } }).response;
          if (!endpoint?.responses || !response) throw error;
          const contentType = responseContentType(response.headers);
          const contract = findResponseContract(endpoint, response.status, contentType);
          if (contract?.stream) throw error;
          const schema = contract?.schema;
          if (!schema) throw new Error(`Otsc: No response contract for ${response.status} ${String(contentType ?? "")}`);
          const parsed = await safeParseAsync(schema, response.data);
          if (!parsed.success) throw new OtscError(`Otsc: Invalid response from endpoint '${endpoint.method} ${endpoint.path}'`, config, response.data, parsed.error);
          if (shouldResponse(transform)) response.data = parsed.data;
          throw error;
        }
      : undefined,
  };
}
