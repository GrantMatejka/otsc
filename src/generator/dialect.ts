export function isSupportedSchemaDialect(value: unknown): boolean {
  return typeof value === "string" && (
    /^https:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/.test(value) ||
    /^https:\/\/spec\.openapis\.org\/oas\/3\.[12]\/dialect\/(?:base|\d{4}-\d{2}-\d{2})#?$/.test(value)
  );
}
