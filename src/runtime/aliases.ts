const reservedAliases = new Set([
  'api', 'axios', 'axiosInstance', 'baseURL', 'clientBaseURL', 'options', 'endpointPlugins',
  'request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'trace', 'query', 'httpOptions',
  'use', 'eject', 'initPlugins', 'getAnyEndpointPlugins', 'findAliasEndpointPlugins',
  'findEnpointPlugins', 'injectAliasEndpoints', 'requestReadMethod', 'constructor', 'prototype', 'then',
]);

export function isReservedAlias(alias: string): boolean {
  return reservedAliases.has(alias) || Object.prototype.hasOwnProperty.call(Object.prototype, alias);
}
