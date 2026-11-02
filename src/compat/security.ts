type SecurityScheme = { type: string; in?: string; name?: string; scheme?: string };

export type CompatibilitySecurity = {
  requirements: Record<string, string[]>[];
  schemes: Record<string, SecurityScheme>;
};

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Normalize the effective security declaration for an operation. */
export function buildCompatibilitySecurity(
  document: object,
  operation: object,
  dereference: (value: any) => unknown,
): CompatibilitySecurity | undefined {
  if (!object(document) || !object(operation)) throw new Error('OTSC compatibility: document and operation must be objects');
  const effective = operation.security !== undefined ? operation.security : document.security;
  if (effective === undefined) return undefined;
  if (!Array.isArray(effective)) throw new Error('OTSC compatibility: security requirements must be an array');

  const swagger2 = document.swagger === '2.0';
  const definitions = swagger2
    ? document.securityDefinitions
    : object(document.components) ? document.components.securitySchemes : undefined;
  const requirements: Record<string, string[]>[] = [];
  const schemes: Record<string, SecurityScheme> = Object.create(null);

  for (const requirement of effective) {
    if (!object(requirement)) throw new Error('OTSC compatibility: each security requirement must be an object');
    const normalized: Record<string, string[]> = Object.create(null);
    for (const [name, scopes] of Object.entries(requirement)) {
      if (!Array.isArray(scopes) || scopes.some(scope => typeof scope !== 'string')) {
        throw new Error(`OTSC compatibility: security scopes for ${JSON.stringify(name)} must be an array of strings`);
      }
      normalized[name] = [...scopes];
      if (Object.hasOwn(schemes, name)) continue;
      if (!object(definitions) || !Object.hasOwn(definitions, name)) {
        throw new Error(`OTSC compatibility: security scheme ${JSON.stringify(name)} is not defined`);
      }
      let definition: unknown;
      try {
        definition = dereference(definitions[name]);
      } catch (cause) {
        throw new Error(`OTSC compatibility: failed to dereference security scheme ${JSON.stringify(name)}`, { cause });
      }
      if (!object(definition)) throw new Error(`OTSC compatibility: security scheme ${JSON.stringify(name)} must be an object`);
      if (definition.type === 'apiKey' && typeof definition.name === 'string' && definition.name &&
          typeof definition.in === 'string' && (swagger2 ? ['header', 'query'] : ['header', 'query', 'cookie']).includes(definition.in)) {
        schemes[name] = { type: 'apiKey', in: definition.in, name: definition.name };
      } else if (swagger2 && definition.type === 'basic') {
        schemes[name] = { type: 'http', scheme: 'basic' };
      } else if (definition.type === 'http' && typeof definition.scheme === 'string' && ['basic', 'bearer'].includes(definition.scheme.toLowerCase())) {
        schemes[name] = { type: 'http', scheme: definition.scheme };
      } else if (definition.type === 'oauth2' || (!swagger2 && definition.type === 'openIdConnect')) {
        schemes[name] = { type: definition.type };
      } else {
        throw new Error(`OTSC compatibility: unsupported or malformed security scheme ${JSON.stringify(name)} (${String(definition.type)})`);
      }
    }
    requirements.push(normalized);
  }
  return { requirements, schemes };
}
