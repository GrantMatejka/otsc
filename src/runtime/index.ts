export { Otsc } from "./otsc.js";
export type { ApiOf } from "./otsc.js";
export type { OtscInstance, OtscClass, OtscConstructor } from "./otsc.js";
export { OtscError } from "./otsc-error.js";
export { isErrorFromPath, isErrorFromAlias } from "./otsc-error.utils.js";
export { streamBytes, parseNdjson, parseJsonSequence, parseSse, parseSseJson, validateStream, StreamingCapabilityError, StreamingParseError } from "./streaming/index.js";
export type { StreamingBody, StreamingOptions, ServerSentEvent } from "./streaming/index.js";
export { encodeRequestBody } from "./body/index.js";
export type { EncodeRequestBodyOptions, EncodedRequestBody, RequestBodyFieldEncoding } from "./body/index.js";
export { selectServer, substituteServerVariables } from "./servers/index.js";
export type { Server, ServerDefinition, ServerSelectionOptions, ServerVariable, ServerVariables } from "./servers/index.js";
export type {
  AnyOtscMethodOptions,
  AnyOtscRequestOptions,
  Aliases,
  BodySchema,
  BodySchemaByAlias,
  BodySchemaForEndpoint,
  ErrorsToAxios,
  MutationMethod,
  RequestFormat,
  OtscBodyForEndpoint,
  OtscBodyByPath,
  OtscBodyByAlias,
  OtscBodyMethodArgs,
  OtscCookieParamsForEndpoint,
  OtscCookieParamsByPath,
  OtscCookieParamsByAlias,
  OtscHeaderParamsForEndpoint,
  OtscHeaderParamsByPath,
  OtscHeaderParamsByAlias,
  Method,
  OtscPathParams,
  OtscPathParamsForEndpoint,
  OtscPathParamsByPath,
  OtscPathParamByAlias,
  OtscPathsByMethod,
  OtscResponseForEndpoint,
  OtscResponseByPath,
  OtscResponseByAlias,
  OtscQueryParamsForEndpoint,
  OtscQueryParamsByPath,
  OtscQueryParamsByAlias,
  OtscEndpointDefinitionByPath,
  OtscEndpointDefinitionByAlias,
  OtscErrorForEndpoint,
  OtscDefaultErrorForEndpoint,
  OtscMatchingErrorsByPath,
  OtscMatchingErrorsByAlias,
  OtscErrorByPath,
  OtscErrorByAlias,
  OtscEndpointDefinition,
  OtscEndpointDefinitions,
  OtscEndpointParameter,
  OtscEndpointParameters,
  OtscEndpointError,
  OtscEndpointErrors,
  OtscOptions,
  OtscRequestOptions,
  OtscMethodOptions,
  OtscRequestOptionsByPath,
  OtscRequestOptionsByAlias,
  OtscReadMethodArgs,
  OtscMutationAliasRequest,
  OtscAliasRequest,
  OtscAliases,
  OtscPlugin,
} from "./otsc.types.js";
export {
  PluginId,
  zodValidationPlugin,
  formDataPlugin,
  formURLPlugin,
  headerPlugin,
} from "./plugins/index.js";

export {
  makeApi,
  makeCrudApi,
  apiBuilder,
  parametersBuilder,
  makeParameters,
  makeEndpoint,
  makeErrors,
  checkApi,
  prefixApi,
  mergeApis,
} from "./api.js";
