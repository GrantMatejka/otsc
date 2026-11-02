import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  mkdir,
  rename,
  unlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { compileSchema, compileSchemaMetadata } from "./schema/index.js";
import { inferSchemaType } from "./schema/type.js";
import { prepareStandaloneFallback } from "./fallback.js";
import { compileStandaloneValidator as compileValidator } from "./validation/index.js";
import { projectSchema, type ProjectionDirection } from "./projection/index.js";
import { emitStandaloneRuntime } from "./standalone/index.js";
import { isSupportedSchemaDialect } from "./dialect.js";
import { isBinaryMediaType } from "../runtime/media.js";
import { isReservedAlias } from "../runtime/aliases.js";
import { createResourceIndex, resolveUri, type ResourceIndex } from "./resources/index.js";

export { createReferenceLock, verifyReferenceLock } from "./lock.js";
export type { ReferenceLock } from "./lock.js";
export { compileSchema } from "./schema/index.js";
export type { CompileSchemaOptions } from "./schema/index.js";
export { compileStandaloneValidator } from "./validation/index.js";
export type { StandaloneValidatorOptions } from "./validation/index.js";
export { projectSchema, ProjectionError } from "./projection/index.js";
export type { ProjectionDirection, ProjectionOptions, ProjectionResult } from "./projection/index.js";
export { createResourceIndex, ResourceIndex, ResourceResolutionError, resolveUri } from "./resources/index.js";
export type { ResourceDocument, ResolvedResource } from "./resources/index.js";
export { emitStandaloneRuntime } from "./standalone/index.js";
export type { StandaloneRuntimeOptions } from "./standalone/index.js";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  message: string;
  location?: { uri: string; pointer: string };
  referenceChain?: readonly string[];
}
export interface GeneratedFile {
  path: string;
  content: string;
}
export interface GeneratorOptions {
  outputFile?: string;
  baseUrl?: string;
  schemaOnly?: boolean;
  standalone?: boolean;
  compileSchemas?: boolean;
  schemaMetadata?: boolean;
  assertFormats?: boolean;
  /** Base URI for an in-memory OpenAPI description and its relative references. */
  documentUri?: string;
  /** Load a resource by absolute URI, optionally reporting its final retrieval URI. */
  loadResource?: (uri: string) => string | { text: string; uri?: string } | undefined | Promise<string | { text: string; uri?: string } | undefined>;
  /** Permit the default loader to make HTTP requests. */
  allowNetwork?: boolean;
  /** Maximum number of distinct resources to load, including the root document. */
  maxResources?: number;
  /** Maximum UTF-8 size of each loaded resource. */
  maxResourceBytes?: number;
  /** Timeout in milliseconds for each HTTP request. */
  resourceTimeoutMs?: number;
  /** Allowed URI schemes, with or without a trailing colon. */
  allowedProtocols?: readonly string[];
  serverIndex?: number;
  serverVariables?: Readonly<Record<string, string>>;
}
export interface GenerationManifest {
  formatVersion: 1;
  generator: string;
  optionsHash: string;
  inputs: readonly { uri: string; sha256: string; baseUri?: string }[];
  outputs: readonly { path: string; sha256: string }[];
}
export interface ContractInspection {
  schemas: readonly { name: string; reference: string }[];
  operations: readonly {
    method: string;
    path: string;
    alias: string;
    responses: readonly string[];
    querystring?: readonly {
      name: string;
      required: boolean;
      media: readonly { mediaType: string; schema: string }[];
    }[];
  }[];
}
export interface GenerationResult {
  files: readonly GeneratedFile[];
  diagnostics: readonly Diagnostic[];
  manifest: GenerationManifest;
  contracts: ContractInspection;
}
export interface WriteOptions {
  outputDir?: string;
  check?: boolean;
  dryRun?: boolean;
}
export interface WriteResult {
  written: readonly string[];
  unchanged: readonly string[];
  changed: readonly string[];
}

type Obj = Record<string, any>;
type Resource = { uri: string; value: Obj | boolean; digest: string; baseUri: string };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Obj =>
  !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: unknown): string[] =>
  object(value) ? Object.keys(value).sort() : [];
const pointerPart = (value: string) =>
  value.replace(/~/g, "~0").replace(/\//g, "~1");
const safeJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
function sourceLiteral(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sourceLiteral).join(", ")}]`;
  if (object(value))
    return `{ ${keys(value)
      .map((key) => `[${safeJson(key)}]: ${sourceLiteral(value[key])}`)
      .join(", ")} }`;
  return safeJson(value);
}
const reserved = new Set(
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield z schemas endpoints servers createApiClient makeApi Otsc OtscOptions".split(
    " ",
  ),
);
function identifier(value: string, fallback = "Schema"): string {
  let name = value.replace(/[^A-Za-z0-9_$]+/g, "_");
  if (!name) name = fallback;
  if (!/^[$_A-Za-z]/.test(name)) name = `_${name}`;
  if (reserved.has(name)) name += "_";
  return name;
}
function allocate(base: string, used: Set<string>): string {
  const name = identifier(base);
  let candidate = name;
  let suffix = 2;
  while (used.has(candidate)) candidate = `${name}_${suffix++}`;
  used.add(candidate);
  return candidate;
}
function location(uri: string, pointer: string) {
  return { uri, pointer };
}
function splitRef(ref: string): [string, string] {
  const url = new URL(ref);
  const fragment = url.hash;
  url.hash = "";
  return [url.href, fragment];
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (object(value))
    return `{${keys(value)
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Load a document and produce deterministic TypeScript without writing files. */
export async function generateClient(
  input: string | object,
  options: GeneratorOptions = {},
): Promise<GenerationResult> {
  const diagnostics: Diagnostic[] = [];
  const resources = new Map<string, Resource>();
  let rootUri =
    typeof input === "string"
      ? /^https?:\/\//i.test(input) || /^file:/i.test(input)
        ? new URL(input).href
        : pathToFileURL(path.resolve(input)).href
      : "memory:///openapi.json";
  let invalidDocumentUri: string | undefined;
  if (options.documentUri !== undefined) {
    try {
      if (typeof input === "string") throw new Error("documentUri applies only to in-memory input");
      const parsed = new URL(options.documentUri);
      if (parsed.hash) throw new Error("documentUri must not have a fragment");
      rootUri = parsed.href;
    } catch (cause) { invalidDocumentUri = cause instanceof Error ? cause.message : String(cause); }
  }
  const logicalUri = (uri: string) => {
    if (uri === rootUri) return "root";
    if (rootUri.startsWith("file:") && uri.startsWith("file:"))
      return path
        .relative(path.dirname(fileURLToPath(rootUri)), fileURLToPath(uri))
        .split(path.sep)
        .join("/");
    return uri;
  };
  const error = (code: string, message: string, uri = rootUri, pointer = "") =>
    diagnostics.push({
      code,
      severity: "error",
      message,
      location: location(logicalUri(uri), pointer),
    });
  if (invalidDocumentUri) error("INVALID_DOCUMENT_URI", invalidDocumentUri);
  for (const [name, value] of [["maxResources", options.maxResources], ["maxResourceBytes", options.maxResourceBytes], ["resourceTimeoutMs", options.resourceTimeoutMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || (name === "resourceTimeoutMs" && value > 0x7fffffff)))
      error("INVALID_LOADER_OPTION", `${name} must be a positive safe integer${name === "resourceTimeoutMs" ? " no greater than 2147483647" : ""}`);
  }
  const protocolsValid = options.allowedProtocols === undefined || (Array.isArray(options.allowedProtocols) && options.allowedProtocols.every(protocol => typeof protocol === "string" && /^[a-z][a-z0-9+.-]*:?$/i.test(protocol)));
  if (!protocolsValid) error("INVALID_LOADER_OPTION", "allowedProtocols must contain valid URI schemes");
  const allowedProtocols = protocolsValid ? options.allowedProtocols?.map(protocol => protocol.toLowerCase().replace(/:$/, "")) : [];
  const checkProtocol = (uri: string): void => {
    const protocol = new URL(uri).protocol.slice(0, -1).toLowerCase();
    if (allowedProtocols && !allowedProtocols.includes(protocol)) throw new Error(`Resource protocol ${protocol} is not allowed for ${uri}`);
  };
  async function load(uri: string): Promise<Resource> {
    const cached = resources.get(uri);
    if (cached) return cached;
    if (options.maxResources !== undefined && resources.size >= options.maxResources) throw new Error(`Resource limit of ${options.maxResources} exceeded`);
    checkProtocol(uri);
    let text: string;
    let retrievalUri = uri;
    if (uri === rootUri && typeof input !== "string") text = stable(input);
    else {
      const provided = await options.loadResource?.(uri);
      if (typeof provided === "string") text = provided;
      else if (provided !== undefined) {
        if (!object(provided) || typeof provided.text !== "string" || (provided.uri !== undefined && typeof provided.uri !== "string")) throw new Error(`Custom loader returned an invalid resource for ${uri}`);
        text = provided.text;
        if (provided.uri !== undefined) retrievalUri = new URL(provided.uri, uri).href;
      }
      else if (uri.startsWith("file:")) text = await readFile(fileURLToPath(uri), "utf8");
      else if (/^https?:/.test(uri)) {
        if (options.allowNetwork === false) throw new Error(`Network access is disabled for ${uri}`);
        let current = uri;
        let response: Response | undefined;
        for (let redirects = 0; redirects <= 10; redirects++) {
          checkProtocol(current);
          if (!/^https?:/i.test(current)) throw new Error(`Unsupported HTTP redirect URI ${current}`);
          response = await fetch(current, { redirect: "manual", ...(options.resourceTimeoutMs === undefined ? {} : { signal: AbortSignal.timeout(options.resourceTimeoutMs) }) });
          if (response.status < 300 || response.status >= 400) break;
          const next = response.headers.get("location");
          if (!next) throw new Error(`HTTP ${response.status} redirect has no Location loading ${current}`);
          await response.body?.cancel();
          if (redirects === 10) throw new Error(`Too many redirects loading ${uri}`);
          const redirected = new URL(next, current);
          redirected.hash = "";
          current = redirected.href;
        }
        if (!response || !response.ok) throw new Error(`HTTP ${response?.status} loading ${current}`);
        retrievalUri = current;
        if (options.maxResourceBytes === undefined || !response.body) text = await response.text();
        else {
          const chunks: Uint8Array[] = [];
          let size = 0;
          const reader = response.body.getReader();
          try {
            for (;;) {
              const item = await reader.read();
              if (item.done) break;
              size += item.value.byteLength;
              if (size > options.maxResourceBytes) throw new Error(`Resource exceeds ${options.maxResourceBytes} bytes: ${current}`);
              chunks.push(item.value);
            }
          } finally { await reader.cancel().catch(() => undefined); }
          text = Buffer.concat(chunks).toString("utf8");
        }
      } else throw new Error(`Unsupported resource URI ${uri}`);
    }
    const finalUrl = new URL(retrievalUri);
    checkProtocol(finalUrl.href);
    if (finalUrl.hash) throw new Error(`Resource retrieval URI must not contain a fragment: ${retrievalUri}`);
    retrievalUri = finalUrl.href;
    if (options.maxResourceBytes !== undefined && Buffer.byteLength(text, "utf8") > options.maxResourceBytes) throw new Error(`Resource exceeds ${options.maxResourceBytes} bytes: ${uri}`);
    const value = parseYaml(text) as unknown;
    if (!object(value) && (uri === rootUri || typeof value !== "boolean"))
      throw new Error(`Expected ${uri === rootUri ? "an OpenAPI object" : "an object or boolean schema"} in ${logicalUri(uri)}`);
    const digest = hash(text);
    const existing = [...resources.values()].find(resource => resource.baseUri === retrievalUri);
    if (existing && existing.digest !== digest) throw new Error(`Conflicting contents for resource URI ${retrievalUri}`);
    const resource: Resource = { uri, value: existing?.value ?? value, digest, baseUri: retrievalUri };
    resources.set(uri, resource);
    return resource;
  }
  let root: Resource | undefined;
  try {
    root = await load(rootUri);
  } catch (cause) {
    error("LOAD_ERROR", String(cause));
  }
  // Index only actual schema positions in OpenAPI documents: arbitrary objects may
  // contain $id or $anchor as data and must not create schema resources.
  const uriPointerPart = (value: string) => encodeURIComponent(pointerPart(value));
  const schemaPointers = (value: unknown): string[] => {
    const found: string[] = [];
    const walk = (node: unknown, pointer: string): void => {
      if (Array.isArray(node)) { node.forEach((item, i) => walk(item, `${pointer}/${i}`)); return; }
      if (!object(node)) return;
      if (legacyReferenceObjects && typeof node.$ref === "string") return;
      for (const key of keys(node)) {
        if (key.startsWith("x-") || ["example", "examples", "default", "enum", "const"].includes(key)) continue;
        const childPointer = `${pointer}/${uriPointerPart(key)}`;
        if ((key === "schema" || key === "itemSchema") && (object(node[key]) || typeof node[key] === "boolean")) found.push(childPointer);
        else if ((pointer === "/components" && key === "schemas") || (pointer === "" && key === "definitions" && typeof (value as Obj)?.swagger === "string")) {
          for (const name of keys(node[key])) found.push(`${childPointer}/${uriPointerPart(name)}`);
        } else walk(node[key], childPointer);
      }
    };
    walk(value, "");
    return found;
  };
  const legacyReferenceObjects = object(root?.value) && (typeof root.value.swagger === "string" && root.value.swagger.startsWith("2.") || typeof root.value.openapi === "string" && root.value.openapi.startsWith("3.0."));
  let resourceIndex: ResourceIndex | undefined;
  const rebuildIndex = () => {
    resourceIndex = createResourceIndex([...resources.values()].map(resource => ({
      uri: resource.uri,
      value: resource.value,
      kind: resource.uri === rootUri || (object(resource.value) && (typeof resource.value.openapi === "string" || typeof resource.value.swagger === "string")) ? "document" as const : "schema" as const,
      baseUri: object(resource.value) && typeof resource.value.openapi === "string" && resource.value.openapi.startsWith("3.2.") && resource.value.$self !== undefined
        ? typeof resource.value.$self === "string" ? resolveUri(resource.value.$self, resource.baseUri) : (() => { throw new Error("OpenAPI $self must be a URI reference"); })()
        : resource.baseUri,
      referenceSiblingsIgnored: legacyReferenceObjects,
      schemaPointers: schemaPointers(resource.value).filter(pointer => !options.schemaOnly || resource.uri !== rootUri || pointer.startsWith("/components/schemas/") || pointer.startsWith("/definitions/")),
    })));
  };
  const sourceBases = new WeakMap<object, string>();
  const indexedSchemas = new WeakSet<object>();
  async function scan(value: unknown, uri: string, pointer = ""): Promise<void> {
    let base = uri;
    try { base = resourceIndex!.resolve(`#${pointer}`, uri).base; }
    catch (cause) { error("REFERENCE_ERROR", String(cause), uri, pointer); return; }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) await scan(value[i], uri, `${pointer}/${i}`);
      return;
    }
    if (!object(value)) return;
    sourceBases.set(value, base);
    if (resourceIndex!.schemaLocation(`#${pointer}`, uri)) indexedSchemas.add(value);
    if (typeof value.$ref === "string") {
      try {
        let target;
        try { target = resourceIndex!.resolve(value.$ref, base); }
        catch (cause) {
          if (!(cause instanceof Error) || !cause.message.startsWith("Unknown resource ")) throw cause;
          const [targetUri] = splitRef(resolveUri(value.$ref, base));
          await load(targetUri);
          rebuildIndex();
          target = resourceIndex!.resolve(value.$ref, base);
        }
      } catch (cause) { error("REFERENCE_ERROR", String(cause), uri, pointer); }
      if (legacyReferenceObjects) return;
    }
    for (const key of keys(value))
      if (!key.startsWith("x-") && !["$ref", "example", "examples", "default", "const", "enum"].includes(key))
        await scan(value[key], uri, `${pointer}/${uriPointerPart(key)}`);
  }
  if (root) {
    try {
      rebuildIndex();
      const scannedDocuments = new Set<string>();
      while ([...resources.keys()].some(uri => !scannedDocuments.has(uri))) {
        const resource = [...resources.values()].find(item => !scannedDocuments.has(item.uri))!;
        scannedDocuments.add(resource.uri);
        if (options.schemaOnly && resource.uri === rootUri && object(resource.value)) {
          if (object(resource.value.components?.schemas)) await scan(resource.value.components.schemas, resource.uri, "/components/schemas");
          if (object(resource.value.definitions)) await scan(resource.value.definitions, resource.uri, "/definitions");
        } else await scan(resource.value, resource.uri);
      }
    } catch (cause) { error("RESOURCE_INDEX_ERROR", String(cause)); }
  }
  // Rebase references before handing schemas to modules whose callbacks do not
  // receive the location of each nested subschema.
  const schemaMaps = new Set(["$defs", "definitions", "properties", "patternProperties", "dependentSchemas", "dependencies"]);
  const schemaSingles = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "items", "additionalItems", "contains", "unevaluatedItems", "not", "if", "then", "else", "contentSchema"]);
  const schemaArrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
  function normalizeSchema(value: any, inheritedBase: string): any {
    if (!object(value)) return value;
    const base = sourceBases.get(value) ?? inheritedBase;
    if (legacyReferenceObjects && typeof value.$ref === "string") return { $ref: resolveUri(value.$ref, base) };
    if ("$id" in value && !indexedSchemas.has(value)) throw new Error("Schema $id at an unindexed location cannot be resolved safely");
    if ("$dynamicRef" in value) throw new Error("Dynamic references require dynamic scope and are unsupported");
    const result: Obj = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$id") continue;
      if (key === "$ref" && typeof child === "string") result[key] = resolveUri(child, base);
      else if (schemaMaps.has(key) && object(child)) result[key] = Object.fromEntries(Object.entries(child).map(([name, entry]) => [name, normalizeSchema(entry, base)]));
      else if (schemaSingles.has(key)) result[key] = Array.isArray(child) ? child.map(entry => normalizeSchema(entry, base)) : normalizeSchema(child, base);
      else if (schemaArrays.has(key) && Array.isArray(child)) result[key] = child.map(entry => normalizeSchema(entry, base));
      else result[key] = child;
    }
    return result;
  }
  const doc = object(root?.value) ? root.value : {};
  const version =
    typeof doc.openapi === "string"
      ? doc.openapi
      : typeof doc.swagger === "string"
        ? doc.swagger
        : "";
  const dialect = version.startsWith("2.")
    ? "swagger2"
    : version.startsWith("3.0.")
      ? "openapi3.0"
      : version.startsWith("3.1.")
        ? "openapi3.1"
        : version.startsWith("3.2.")
          ? "openapi3.2"
          : "";
  if (root && !dialect)
    error(
      "UNSUPPORTED_VERSION",
      `Unsupported or missing OpenAPI version: ${version || "(missing)"}`,
    );
  if (doc.jsonSchemaDialect !== undefined && !isSupportedSchemaDialect(doc.jsonSchemaDialect))
    error("UNSUPPORTED_DIALECT", `Unsupported JSON Schema dialect: ${String(doc.jsonSchemaDialect)}`, rootUri, "/jsonSchemaDialect");
  if (options.assertFormats && (dialect === "swagger2" || dialect === "openapi3.0"))
    error("UNSUPPORTED_FORMAT_ASSERTION", "Format assertions currently require OpenAPI 3.1 or 3.2");
  const resolve = (
    ref: string,
    uri = rootUri,
  ): { value: any; uri: string; fragment: string; canonical: string } => {
    if (!resourceIndex) throw new Error("Resource index unavailable");
    const target = resourceIndex.resolve(ref, uri);
    const [, fragment] = splitRef(target.id);
    return { value: target.value, uri: target.base, fragment, canonical: target.id };
  };
  const deref = (
    value: any,
    uri = rootUri,
  ): { value: any; uri: string; pointer?: string } => {
    let pointer: string | undefined;
    const visited = new Set<string>();
    const referenceAnnotations: Record<string, string> = Object.create(null);
    if (object(value)) uri = sourceBases.get(value) ?? uri;
    while (object(value) && typeof value.$ref === "string") {
      if (dialect === "openapi3.1" || dialect === "openapi3.2") {
        for (const key of ["summary", "description"]) {
          if (!(key in referenceAnnotations) && typeof value[key] === "string") referenceAnnotations[key] = value[key];
        }
      }
      const target = resolve(value.$ref, uri);
      if (visited.has(target.canonical))
        throw new Error(`Reference cycle at ${value.$ref}`);
      visited.add(target.canonical);
      value = target.value;
      uri = target.uri;
      pointer = target.fragment.startsWith("#/")
        ? target.fragment.slice(1)
        : "";
    }
    if (object(value) && Object.keys(referenceAnnotations).length) value = { ...value, ...referenceAnnotations };
    return { value, uri: object(value) ? sourceBases.get(value) ?? uri : uri, pointer };
  };
  const used = new Set<string>(reserved);
  const symbols = new Map<
    string,
    { name: string; value: any; uri: string; fragment: string }
  >();
  const components =
    dialect === "swagger2" ? doc.definitions : doc.components?.schemas;
  const componentPath =
    dialect === "swagger2" ? "#/definitions/" : "#/components/schemas/";
  for (const name of keys(components)) {
    let resolvedComponent;
    try { resolvedComponent = resolve(componentPath + uriPointerPart(name), rootUri); }
    catch (cause) { error("REFERENCE_ERROR", String(cause), rootUri, componentPath.slice(1) + pointerPart(name)); continue; }
    const ref = resolvedComponent.canonical;
    let componentSchema;
    try { componentSchema = normalizeSchema(components[name], resolvedComponent.uri); }
    catch (cause) { error("SCHEMA_COMPILE_ERROR", String(cause), rootUri, componentPath.slice(1) + pointerPart(name)); continue; }
    symbols.set(ref, {
      name: allocate(name, used),
      value: componentSchema,
      uri: resolvedComponent.uri,
      fragment: componentPath + pointerPart(name),
    });
  }
  function registerRefs(value: unknown, uri: string): void {
    if (Array.isArray(value)) {
      value.forEach((element) => registerRefs(element, uri));
      return;
    }
    if (!object(value)) return;
    if (typeof value.$ref === "string") {
      try {
        const target = resolve(value.$ref, uri);
        if (!symbols.has(target.canonical)) {
          const raw = target.fragment.split("/").pop() || "ReferencedSchema";
          symbols.set(target.canonical, {
            name: allocate(
              decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~"),
              used,
            ),
            value: normalizeSchema(target.value, target.uri),
            uri: target.uri,
            fragment: target.fragment,
          });
          registerRefs(normalizeSchema(target.value, target.uri), target.uri);
        }
      } catch {}
    }
    for (const key of keys(value))
      if (
        !key.startsWith("x-") && !["$ref", "example", "examples", "default", "enum", "const"].includes(
          key,
        )
      )
        registerRefs(value[key], uri);
  }
  for (const symbol of [...symbols.values()])
    registerRefs(symbol.value, symbol.uri);
  const projectedSymbols = new Map<
    string,
    {
      name: string;
      value: any;
      uri: string;
      fragment: string;
      direction: ProjectionDirection;
      binaryInput?: boolean;
    }
  >();
  const expressions = new Map<string, string>();
  const referenceBindings = new Map<string, string>();
  const validators = new Map<string, { binding: string; code: string }>();
  const compiledValidators = new Map<string, string>();
  const cachedValidator: typeof compileValidator = (schema, validatorOptions = {}) => {
    const key = hash(stable({ schema, options: validatorOptions }));
    const cached = compiledValidators.get(key);
    if (cached !== undefined) return cached;
    const code = compileValidator(schema, validatorOptions);
    compiledValidators.set(key, code);
    return code;
  };
  const issuePathBinding = allocate("jsonSchemaIssuePath", used);
  const wireValidationBinding = allocate("withJsonSchemaValidation", used);
  const compileRaw = (
    schema: unknown,
    uri: string,
    pointer: string,
    direction?: ProjectionDirection,
    binaryInput = false,
  ): string => {
    try {
      schema = normalizeSchema(schema, uri);
      registerRefs(schema, uri);
      const resolveProjected = (reference: string, sourceUri: string) => {
        const target = resolve(reference, sourceUri);
        if (!direction) return { ...target, value: normalizeSchema(target.value, target.uri) };
        const projected = projectedSymbols.get(
          `${direction}${binaryInput ? "-binary" : ""}|${target.canonical}`,
        );
        if (!projected)
          throw new Error(`Missing ${direction} projection for ${reference}`);
        return { ...target, value: projected.value };
      };
      const containsFeature = (value: unknown, sourceUri: string, visited: Set<string>, matches: (schema: Obj) => boolean): boolean => {
        if (!object(value)) return false;
        if (matches(value)) return true;
        if (typeof value.$ref === "string") {
          const target = resolveProjected(value.$ref, sourceUri);
          if (!visited.has(target.canonical)) {
            visited.add(target.canonical);
            if (containsFeature(target.value, target.uri, visited, matches)) return true;
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (schemaMaps.has(key) && object(child) && Object.values(child).some(entry => containsFeature(entry, sourceUri, visited, matches))) return true;
          if (schemaSingles.has(key) && (Array.isArray(child) ? child.some(entry => containsFeature(entry, sourceUri, visited, matches)) : containsFeature(child, sourceUri, visited, matches))) return true;
          if (schemaArrays.has(key) && Array.isArray(child) && child.some(entry => containsFeature(entry, sourceUri, visited, matches))) return true;
        }
        return false;
      };
      const containsBinary = binaryInput && containsFeature(schema, uri, new Set(), value => value.type === "file" || (value.format === "binary" && (value.type === "string" || (Array.isArray(value.type) && value.type.includes("string")))));
      const needsBinaryWireValidation = containsBinary && containsFeature(schema, uri, new Set(), value =>
        value.unevaluatedProperties !== undefined || value.unevaluatedItems !== undefined || value.uniqueItems === true ||
        (value.const !== null && typeof value.const === "object") || (Array.isArray(value.enum) && value.enum.some((entry: unknown) => entry !== null && typeof entry === "object")) ||
        (options.assertFormats === true && typeof value.format === "string" && !["binary", "byte", "password", "int32", "int64", "float", "double"].includes(value.format))
      );
      const fallback =
        (dialect === "openapi3.1" || dialect === "openapi3.2") && !containsBinary
          ? prepareStandaloneFallback(schema, uri, resolveProjected, { assertFormats: options.assertFormats, compileValidator: cachedValidator })
          : undefined;
      if (needsBinaryWireValidation) throw new Error("Evaluation-dependent validation for binary schemas requires a custom validator");
      const nativeExpression = compileSchema(
        (fallback?.nativeSchema ?? schema) as any,
        {
          resolveRef: (ref: string) => {
            const target = resolve(ref, uri);
            const key = direction
              ? `${direction}${binaryInput ? "-binary" : ""}|${target.canonical}`
              : target.canonical;
            const symbol = direction
              ? projectedSymbols.get(key)
              : symbols.get(key);
            if (!symbol)
              throw new Error(`Unregistered schema reference ${ref}`);
            let binding = referenceBindings.get(key);
            if (!binding) {
              binding = allocate(`${symbol.name}Reference`, used);
              referenceBindings.set(key, binding);
            }
            return binding;
          },
          pointer,
          binaryInput,
          emitMetadata: options.schemaMetadata !== false,
          dialect:
            dialect === "swagger2" ? "3.0" : dialect.replace("openapi", ""),
        } as any,
      );
      if (!fallback) return nativeExpression;
      const digest = hash(fallback.validator).slice(0, 20);
      let validator = validators.get(digest);
      if (!validator) {
        validator = {
          binding: allocate(`validate_${digest}`, used),
          code: fallback.validator,
        };
        validators.set(digest, validator);
      }
      const metadata = options.schemaMetadata === false ? undefined : compileSchemaMetadata(schema);
      return `${wireValidationBinding}(${nativeExpression}, ${validator.binding})${metadata ? `.meta(${metadata})` : ""}`;
    } catch (cause) {
      error("SCHEMA_COMPILE_ERROR", String(cause), uri, pointer);
      return "z.unknown()";
    }
  };
  const compile = (
    schema: unknown,
    uri: string,
    pointer: string,
    direction?: ProjectionDirection,
    binaryInput = false,
  ): string => {
    if (!direction) return compileRaw(schema, uri, pointer, undefined, binaryInput);
    try {
      schema = normalizeSchema(schema, uri);
      const projected = projectSchema(schema as any, {
        direction,
        dialect:
          dialect === "swagger2"
            ? "3.0"
            : (dialect.replace("openapi", "") as "3.0" | "3.1" | "3.2"),
        rootKey: uri,
        resolveRef: (reference, from) => {
          const target = resolve(reference, splitRef(from)[0]);
          return { key: target.canonical, schema: normalizeSchema(target.value, target.uri) as any };
        },
      });
      for (const [reference, value] of projected.references) {
        const key = `${direction}${binaryInput ? "-binary" : ""}|${reference}`;
        const existing = projectedSymbols.get(key);
        if (existing && stable(existing.value) !== stable(value))
          throw new Error(
            `Reference ${reference} requires incompatible ${direction} projection contexts`,
          );
        if (!existing) {
          const [resourceUri, fragment] = splitRef(reference);
          const original = symbols.get(reference);
          projectedSymbols.set(key, {
            name: allocate(
              `${original?.name ?? "ReferencedSchema"}_${direction}${binaryInput ? "_binary" : ""}`,
              used,
            ),
            value,
            uri: resourceUri,
            fragment,
            direction,
            binaryInput,
          });
        }
      }
      return compileRaw(projected.schema, uri, pointer, direction, binaryInput);
    } catch (cause) {
      error("SCHEMA_PROJECTION_ERROR", String(cause), uri, pointer);
      return "z.unknown()";
    }
  };
  const inspectMedia = (media: unknown, uri: string, pointer: string, request = false, streaming = false): void => {
    if (!object(media)) return;
    for (const field of [
      "itemSchema",
      "encoding",
      "itemEncoding",
      "prefixEncoding",
    ]) {
      if (request && field === "encoding") continue;
      if (streaming && field === "itemSchema") continue;
      if (media[field] !== undefined)
        error(
          "UNSUPPORTED_MEDIA_FEATURE",
          `Media ${field} requires streaming or encoding support`,
          uri,
          `${pointer}/${field}`,
        );
    }
  };
  const resolveServer = (servers: unknown, resourceUri: string, pointer: string): string | undefined => {
    if (servers === undefined) return undefined;
    if (!Array.isArray(servers)) {
      error("INVALID_SERVERS", "Servers must be an array", resourceUri, pointer);
      return undefined;
    }
    if (!servers.length) return undefined;
    const index = options.serverIndex ?? 0;
    if (!Number.isSafeInteger(index) || index < 0 || index >= servers.length) {
      error("INVALID_SERVER_INDEX", `Server index ${index} is out of range`, resourceUri, pointer);
      return undefined;
    }
    const server = servers[index];
    if (!object(server) || typeof server.url !== "string") {
      error("INVALID_SERVER", "A server requires a URL", resourceUri, `${pointer}/${index}`);
      return undefined;
    }
    const variables = object(server.variables) ? server.variables : {};
    if (/[{}]/.test(server.url.replace(/\{([^{}]+)\}/g, ""))) {
      error("INVALID_SERVER", "Server URL has an invalid variable template", resourceUri, `${pointer}/${index}/url`);
      return undefined;
    }
    let invalid = false;
    const url = server.url.replace(/\{([^{}]+)\}/g, (_match: string, name: string) => {
      const variable = variables[name];
      if (!object(variable) || typeof variable.default !== "string") {
        invalid = true;
        error("INVALID_SERVER_VARIABLE", `Server variable ${JSON.stringify(name)} requires a string default`, resourceUri, `${pointer}/${index}/variables/${pointerPart(name)}`);
        return "";
      }
      const value = options.serverVariables?.[name] ?? variable.default;
      if (Array.isArray(variable.enum) && !variable.enum.includes(value)) {
        invalid = true;
        error("INVALID_SERVER_VARIABLE", `Value for server variable ${JSON.stringify(name)} is not in its enum`, resourceUri, `${pointer}/${index}/variables/${pointerPart(name)}`);
      }
      return value;
    });
    if (invalid) return undefined;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:/i.test(url)) {
      error("UNSUPPORTED_SERVER_SCHEME", `Axios cannot use server URL ${JSON.stringify(url)}`, resourceUri, `${pointer}/${index}/url`);
      return undefined;
    }
    if (/^https?:\/\//i.test(resourceUri)) {
      try { return new URL(url, resourceUri).href; }
      catch { error("INVALID_SERVER", `Invalid server URL ${JSON.stringify(url)}`, resourceUri, `${pointer}/${index}/url`); return undefined; }
    }
    return url;
  };
  const defaultServers = doc.servers === undefined || (Array.isArray(doc.servers) && doc.servers.length === 0) ? [{ url: "/" }] : doc.servers;
  const defaultServer = !options.schemaOnly && options.baseUrl === undefined && dialect !== "swagger2"
    ? resolveServer(defaultServers, sourceBases.get(doc) ?? rootUri, "/servers")
    : undefined;
  const operations: ContractInspection["operations"][number][] = [];
  const endpointSources: string[] = [];
  const streamSchemas: string[] = [];
  const aliases = new Set<string>();
  const operationIds = new Set<string>();
  const methods = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
    "query",
  ];
  for (const route of options.schemaOnly ? [] : keys(doc.paths)) {
    let item: Obj;
    let itemUri = rootUri;
    try {
      const resolved = deref(doc.paths[route]);
      item = resolved.value;
      itemUri = resolved.uri;
    } catch (cause) {
      error(
        "REFERENCE_ERROR",
        String(cause),
        rootUri,
        `/paths/${pointerPart(route)}`,
      );
      continue;
    }
    if (!object(item)) {
      error("INVALID_PATH", `Path item ${route} must be an object`);
      continue;
    }
    const candidates: {
      method: string;
      operation: unknown;
      pointer: string;
      custom: boolean;
    }[] = [];
    for (const method of methods) {
      if (item[method] === undefined) continue;
      if (method === "query" && dialect !== "openapi3.2") {
        error(
          "UNSUPPORTED_OPERATION",
          "The QUERY operation requires OpenAPI 3.2",
          rootUri,
          `/paths/${pointerPart(route)}/query`,
        );
        continue;
      }
      candidates.push({
        method,
        operation: item[method],
        pointer: `/paths/${pointerPart(route)}/${method}`,
        custom: false,
      });
    }
    if (item.additionalOperations !== undefined) {
      const additionalPointer = `/paths/${pointerPart(route)}/additionalOperations`;
      if (dialect !== "openapi3.2" || !object(item.additionalOperations)) {
        error(
          "INVALID_ADDITIONAL_OPERATIONS",
          "additionalOperations requires an OpenAPI 3.2 map",
          rootUri,
          additionalPointer,
        );
      } else {
        for (const method of keys(item.additionalOperations)) {
          const pointer = `${additionalPointer}/${pointerPart(method)}`;
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method)) {
            error(
              "INVALID_METHOD",
              `Invalid HTTP method token ${JSON.stringify(method)}`,
              rootUri,
              pointer,
            );
          } else if (method !== method.toUpperCase()) {
            error(
              "UNSUPPORTED_METHOD_CASE",
              `HTTP method ${JSON.stringify(method)} cannot retain its case through the Axios transport`,
              rootUri,
              pointer,
            );
          } else if (["CONNECT", "TRACK"].includes(method)) {
            error(
              "UNSUPPORTED_METHOD",
              `HTTP method ${method} is forbidden by browser transports`,
              rootUri,
              pointer,
            );
          } else if (methods.includes(method.toLowerCase())) {
            error(
              "INVALID_ADDITIONAL_OPERATION",
              `Use the standard ${method.toLowerCase()} field for ${method}`,
              rootUri,
              pointer,
            );
          } else {
            candidates.push({
              method,
              operation: item.additionalOperations[method],
              pointer,
              custom: true,
            });
          }
        }
      }
    }
    for (const candidate of candidates) {
      const method = candidate.method;
      const op = candidate.operation;
      const opPointer = candidate.pointer;
      if (!object(op)) {
        error(
          "INVALID_OPERATION",
          `Operation ${method} must be an object`,
          rootUri,
          opPointer,
        );
        continue;
      }
      const operationServer = !options.schemaOnly && options.baseUrl === undefined
        ? resolveServer(op.servers ?? item.servers, itemUri, op.servers !== undefined ? `${opPointer}/servers` : `/paths/${pointerPart(route)}/servers`)
        : undefined;
      const effectiveSecurity =
        op.security !== undefined ? op.security : doc.security;
      let security:
        | {
            requirements: Record<string, string[]>[];
            schemes: Record<string, Record<string, string>>;
          }
        | undefined;
      if (effectiveSecurity !== undefined) {
        const securityPointer =
          op.security !== undefined ? `${opPointer}/security` : "/security";
        if (!Array.isArray(effectiveSecurity)) {
          error(
            "INVALID_SECURITY",
            "Security requirements must be an array",
            rootUri,
            securityPointer,
          );
        } else {
          const requirements: Record<string, string[]>[] = [];
          const schemes: Record<string, Record<string, string>> = Object.create(
            null,
          );
          const definitions =
            dialect === "swagger2"
              ? doc.securityDefinitions
              : doc.components?.securitySchemes;
          for (
            let requirementIndex = 0;
            requirementIndex < effectiveSecurity.length;
            requirementIndex++
          ) {
            const requirement = effectiveSecurity[requirementIndex];
            const requirementPointer = `${securityPointer}/${requirementIndex}`;
            if (!object(requirement)) {
              error(
                "INVALID_SECURITY",
                "Each security requirement must be an object",
                rootUri,
                requirementPointer,
              );
              continue;
            }
            const normalized: Record<string, string[]> = Object.create(null);
            for (const schemeName of keys(requirement)) {
              const scopes = requirement[schemeName];
              if (
                !Array.isArray(scopes) ||
                scopes.some((scope) => typeof scope !== "string")
              ) {
                error(
                  "INVALID_SECURITY",
                  `Security scopes for ${schemeName} must be an array of strings`,
                  rootUri,
                  `${requirementPointer}/${pointerPart(schemeName)}`,
                );
                continue;
              }
              normalized[schemeName] = scopes;
              if (Object.prototype.hasOwnProperty.call(schemes, schemeName))
                continue;
              if (
                !object(definitions) ||
                !Object.prototype.hasOwnProperty.call(definitions, schemeName)
              ) {
                error(
                  "UNKNOWN_SECURITY_SCHEME",
                  `Security scheme ${schemeName} is not defined`,
                  rootUri,
                  `${requirementPointer}/${pointerPart(schemeName)}`,
                );
                continue;
              }
              const definitionPointer = `${dialect === "swagger2" ? "/securityDefinitions" : "/components/securitySchemes"}/${pointerPart(schemeName)}`;
              try {
                const resolvedScheme = deref(definitions[schemeName]);
                const definition = resolvedScheme.value;
                const schemePointer =
                  resolvedScheme.pointer ?? definitionPointer;
                if (!object(definition)) {
                  error(
                    "INVALID_SECURITY_SCHEME",
                    `Security scheme ${schemeName} must be an object`,
                    resolvedScheme.uri,
                    schemePointer,
                  );
                  continue;
                }
                let normalizedScheme: Record<string, string> | undefined;
                if (
                  definition.type === "apiKey" &&
                  typeof definition.name === "string" &&
                  definition.name &&
                  [
                    "header",
                    "query",
                    ...(dialect === "swagger2" ? [] : ["cookie"]),
                  ].includes(definition.in)
                ) {
                  normalizedScheme = {
                    type: "apiKey",
                    in: definition.in,
                    name: definition.name,
                  };
                } else if (
                  dialect === "swagger2" &&
                  definition.type === "basic"
                ) {
                  normalizedScheme = { type: "http", scheme: "basic" };
                } else if (
                  definition.type === "http" &&
                  typeof definition.scheme === "string" &&
                  ["basic", "bearer"].includes(definition.scheme.toLowerCase())
                ) {
                  normalizedScheme = {
                    type: "http",
                    scheme: definition.scheme,
                  };
                } else if (
                  definition.type === "oauth2" ||
                  (dialect !== "swagger2" &&
                    definition.type === "openIdConnect")
                ) {
                  normalizedScheme = { type: definition.type };
                } else {
                  error(
                    "UNSUPPORTED_SECURITY_SCHEME",
                    `Unsupported or malformed security scheme ${schemeName} (${String(definition.type)})`,
                    resolvedScheme.uri,
                    schemePointer,
                  );
                }
                if (normalizedScheme) schemes[schemeName] = normalizedScheme;
              } catch (cause) {
                error(
                  "REFERENCE_ERROR",
                  String(cause),
                  rootUri,
                  definitionPointer,
                );
              }
            }
            requirements.push(normalized);
          }
          security = { requirements, schemes };
        }
      }
      const operationId = typeof op.operationId === "string" && op.operationId ? op.operationId : undefined;
      if (operationId && operationIds.has(operationId)) {
        error(
          "DUPLICATE_OPERATION_ID",
          `Operation ID ${operationId} is duplicated`,
          rootUri,
          opPointer,
        );
        continue;
      }
      if (operationId) operationIds.add(operationId);
      const baseAlias = identifier(operationId ?? `${method}_${route}`, "operation");
      let alias = isReservedAlias(baseAlias) ? `${baseAlias}_` : baseAlias;
      let aliasSuffix = 2;
      while (aliases.has(alias) || isReservedAlias(alias)) alias = `${baseAlias}_${aliasSuffix++}`;
      aliases.add(alias);
      const params = new Map<string, { value: any; uri: string }>();
      for (const [scope, parameters] of [["path", item.parameters], ["operation", op.parameters]] as const) {
        if (parameters === undefined) continue;
        if (!Array.isArray(parameters)) { error("INVALID_PARAMETER", `${scope} parameters must be an array`, itemUri, opPointer); continue; }
        const localNames = new Set<string>();
        for (const parameter of parameters) {
          try {
            const resolved = deref(parameter, itemUri);
            if (!object(resolved.value)) { error("INVALID_PARAMETER", `${scope} parameter must be an object`, itemUri, opPointer); continue; }
            const name = resolved.value.in === "header" && typeof resolved.value.name === "string" ? resolved.value.name.toLowerCase() : resolved.value.name;
            const key = `${resolved.value.in}:${name}`;
            if (localNames.has(key)) { error("DUPLICATE_PARAMETER", `Duplicate ${scope} parameter ${key}`, resolved.uri, opPointer); continue; }
            localNames.add(key);
            params.set(key, resolved);
          } catch (cause) {
            error("REFERENCE_ERROR", String(cause), rootUri, opPointer);
          }
        }
      }
      const templateNames = new Set<string>();
      const placeholderPattern = /\{([^{}]+)\}/g;
      for (const match of route.matchAll(placeholderPattern))
        templateNames.add(match[1]);
      if (/[{}]/.test(route.replace(placeholderPattern, ""))) {
        error(
          "INVALID_PATH_TEMPLATE",
          `Malformed path template ${route}`,
          rootUri,
          opPointer,
        );
      }
      const pathNames = new Set(
        [...params.values()]
          .filter((parameter) => parameter.value.in === "path")
          .map((parameter) => parameter.value.name),
      );
      for (const name of templateNames) {
        if (!pathNames.has(name))
          error(
            "MISSING_PATH_PARAMETER",
            `Path template parameter ${name} has no path parameter declaration`,
            rootUri,
            opPointer,
          );
      }
      for (const name of pathNames) {
        if (!templateNames.has(name))
          error(
            "MISSING_PATH_TEMPLATE",
            `Path parameter ${name} has no matching template expression`,
            rootUri,
            opPointer,
          );
      }
      const querystringParameters = [...params.values()].filter(
        (parameter) => parameter.value.in === "querystring",
      );
      if (
        querystringParameters.length &&
        [...params.values()].some((parameter) => parameter.value.in === "query")
      ) {
        error(
          "INVALID_QUERYSTRING",
          "querystring and query parameters cannot be combined",
          rootUri,
          opPointer,
        );
      }
      if (querystringParameters.length > 1)
        error(
          "INVALID_QUERYSTRING",
          "Only one querystring parameter is permitted",
          rootUri,
          opPointer,
        );
      const querystring: {
        name: string;
        required: boolean;
        media: { mediaType: string; schema: string }[];
      }[] = [];
      const paramSources: string[] = [];
      const formParameters: { value: Obj; uri: string }[] = [];
      let requestFormat: string | undefined;
      const requestBodies: string[] = [];
      const requestFormatFor = (media: string): string | undefined => {
        const normalized = media.split(";", 1)[0]!.trim().toLowerCase();
        if (normalized === "application/json" || normalized.endsWith("+json"))
          return "json";
        if (normalized === "multipart/form-data") return "form-data";
        if (normalized === "application/x-www-form-urlencoded") return "form-url";
        if (isBinaryMediaType(normalized)) return "binary";
        if (normalized.startsWith("text/") || normalized === "application/xml" || normalized.endsWith("+xml")) return "text";
        return undefined;
      };
      const requestMediaFormat = (media: string, schema: unknown, uri: string): string | undefined =>
        requestFormatFor(media) ?? (explicitBinarySchema(schema, uri) ? "binary" : /^(?:\*|[a-z0-9!#$&^_.+-]+)\/\*$/i.test(media.split(";", 1)[0]!.trim()) ? "wildcard" : undefined);
      const binarySchema = (schema: unknown, uri: string, direction: "request" | "response"): string => {
        const expression = direction === "request"
          ? 'z.custom<Blob | ArrayBuffer | Uint8Array>(value => (typeof Blob !== "undefined" && value instanceof Blob) || value instanceof ArrayBuffer || value instanceof Uint8Array)'
          : 'z.custom<Uint8Array>(value => value instanceof Uint8Array)';
        const annotations = new Set(["title", "description", "default", "example", "examples", "deprecated", "readOnly", "writeOnly", "externalDocs", "xml", "$schema"]);
        const visited = new Set<string>();
        let current = normalizeSchema(schema, uri);
        let sourceUri = uri;
        while (object(current) && typeof current.$ref === "string") {
          if (Object.keys(current).some((key) => key !== "$ref" && !annotations.has(key) && !key.startsWith("x-"))) {
            error(`UNSUPPORTED_BINARY_${direction.toUpperCase()}_SCHEMA`, `Binary ${direction} reference siblings cannot be validated as bytes`, sourceUri, opPointer);
            return expression;
          }
          const target = resolve(current.$ref, sourceUri);
          if (visited.has(target.canonical)) throw new Error(`Binary ${direction} schema reference cycle at ${current.$ref}`);
          visited.add(target.canonical);
          current = normalizeSchema(target.value, target.uri);
          sourceUri = target.uri;
        }
        if (current === undefined || current === true) return expression;
        if (object(current)) {
          const constraints = Object.keys(current).filter((key) => !annotations.has(key) && !key.startsWith("x-"));
          const unconstrained = constraints.length === 0;
          const hasMaximum = dialect === "openapi3.2" && current.maxLength !== undefined;
          const byteKeys = constraints.filter(key => key !== "maxLength" || !hasMaximum);
          const rawBytes = byteKeys.length === 0 || (current.type === "file" && byteKeys.every((key) => key === "type")) ||
            (current.type === "string" && current.format === "binary" && byteKeys.every((key) => key === "type" || key === "format"));
          if (unconstrained || rawBytes) {
            if (!hasMaximum) return expression;
            if (!Number.isSafeInteger(current.maxLength) || current.maxLength < 0) {
              error("INVALID_BINARY_LENGTH", `Binary ${direction} maxLength must be a non-negative safe integer`, sourceUri, opPointer);
              return expression;
            }
            const length = direction === "request" ? '"size" in value ? value.size : value.byteLength' : 'value.byteLength';
            return `${expression}.refine(value => (${length}) <= ${current.maxLength})`;
          }
        }
        error(`UNSUPPORTED_BINARY_${direction.toUpperCase()}_SCHEMA`, `This binary ${direction} schema has constraints that cannot be validated as bytes`, sourceUri, opPointer);
        return expression;
      };
      const explicitBinarySchema = (schema: unknown, uri: string): boolean => {
        if (schema === undefined) return false;
        const target = deref(normalizeSchema(schema, uri), uri).value;
        return object(target) && (target.type === "file" || (target.type === "string" && target.format === "binary"));
      };
      for (const resolvedParameter of params.values()) {
        const parameter = resolvedParameter.value;
        if (dialect !== "swagger2" && parameter.in === "header" && typeof parameter.name === "string" && ["accept", "content-type", "authorization"].includes(parameter.name.toLowerCase())) continue;
        if (parameter.in === "formData" && dialect === "swagger2") {
          formParameters.push(resolvedParameter);
          continue;
        }
        if (parameter.in === "querystring") {
          const content = parameter.content;
          const mediaTypes = keys(content);
          if (
            dialect !== "openapi3.2" ||
            typeof parameter.name !== "string" ||
            !parameter.name ||
            mediaTypes.length !== 1
          ) {
            error(
              "INVALID_QUERYSTRING",
              "A querystring parameter requires OpenAPI 3.2, a name, and exactly one content media type",
              rootUri,
              opPointer,
            );
          } else {
            const mediaType = mediaTypes[0];
            const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase();
            const mediaPointer = `${opPointer}/parameters/${pointerPart(parameter.name)}/content/${pointerPart(mediaType)}`;
            let resolvedMedia: ReturnType<typeof deref>;
            try {
              resolvedMedia = deref(content[mediaType], resolvedParameter.uri);
            } catch (cause) {
              error("REFERENCE_ERROR", String(cause), resolvedParameter.uri, mediaPointer);
              continue;
            }
            inspectMedia(
              resolvedMedia.value,
              resolvedMedia.uri,
              mediaPointer,
              true,
            );
            const rawEncoding = resolvedMedia.value?.encoding;
            const encoding = object(rawEncoding) ? Object.fromEntries(Object.entries(rawEncoding).map(([name, value]) => [name, object(value) ? { ...value } : value])) : rawEncoding;
            if (encoding !== undefined) {
              if (normalizedMediaType !== "application/x-www-form-urlencoded" || !object(encoding)) {
                error("UNSUPPORTED_QUERYSTRING_MEDIA", "Whole-query encoding requires application/x-www-form-urlencoded", resolvedMedia.uri, mediaPointer);
              } else for (const [fieldName, fieldEncoding] of Object.entries(encoding)) {
                if (!object(fieldEncoding) || Object.keys(fieldEncoding).some(key => !["contentType", "explode", "style"].includes(key)) ||
                    (fieldEncoding.contentType !== undefined && (typeof fieldEncoding.contentType !== "string" || fieldEncoding.contentType.includes(","))) ||
                    (fieldEncoding.explode !== undefined && typeof fieldEncoding.explode !== "boolean") ||
                    (fieldEncoding.style !== undefined && !["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(fieldEncoding.style)) ||
                    ((fieldEncoding.style === "spaceDelimited" || fieldEncoding.style === "pipeDelimited") && fieldEncoding.explode === true)) {
                  error("UNSUPPORTED_REQUEST_ENCODING", `Unsupported whole-query encoding for field ${fieldName}`, resolvedMedia.uri, mediaPointer);
                } else if (fieldEncoding.style === "deepObject") fieldEncoding.explode = true;
              }
            }
            if (
              ![
                "application/json",
                "application/x-www-form-urlencoded",
                "text/plain",
                "application/jsonpath",
              ].includes(normalizedMediaType)
            ) {
              error(
                "UNSUPPORTED_QUERYSTRING_MEDIA",
                `Unsupported whole-query media type ${mediaType}`,
                resolvedParameter.uri,
                mediaPointer,
              );
            } else {
              const querySchema = compile(
                resolvedMedia.value?.schema ?? {},
                resolvedMedia.uri,
                opPointer,
                "request",
              );
              querystring.push({
                name: parameter.name,
                required: parameter.required === true,
                media: [{ mediaType, schema: querySchema }],
              });
              const serialization = {
                in: "querystring",
                name: parameter.name,
                mediaType: normalizedMediaType,
                required: parameter.required === true,
                ...(encoding === undefined ? {} : { encoding }),
              };
              paramSources.push(
                `{ name: ${safeJson(parameter.name)}, type: "Query", schema: ${querySchema}${parameter.required ? "" : ".optional()"}, serialization: ${safeJson(serialization)} }`,
              );
            }
          }
          continue;
        }
        if (parameter.in === "body") {
          const consumes = op.consumes ?? doc.consumes ?? ["application/json"];
          const bodySchemas: string[] = [];
          for (const mediaType of consumes) {
            const format = requestMediaFormat(mediaType, parameter.schema, resolvedParameter.uri);
            if (!format) error("UNSUPPORTED_REQUEST_MEDIA", `Unsupported request media ${mediaType}`, rootUri, opPointer);
            else {
              if (format !== "wildcard") requestFormat ??= format;
              const compiled = format === "binary" ? binarySchema(parameter.schema, resolvedParameter.uri, "request") : compile(parameter.schema ?? {}, resolvedParameter.uri, opPointer, "request", format === "form-data");
              const bodySchema = format === "text" ? `z.intersection(z.string(), ${compiled})` : compiled;
              bodySchemas.push(bodySchema);
              requestBodies.push(`{ mediaType: ${safeJson(mediaType)}, schema: ${bodySchema}, required: ${parameter.required === true} }`);
            }
          }
          const uniqueSchemas = [...new Set(bodySchemas)];
          const bodySchema = uniqueSchemas.length === 1 ? uniqueSchemas[0] : `z.union([${uniqueSchemas.join(", ")}])`;
          paramSources.push(
            `{ name: "body", type: "Body", schema: ${bodySchema}${parameter.required ? "" : ".optional()"} }`,
          );
          continue;
        }
        const types: Record<string, string> = {
          path: "Path",
          query: "Query",
          header: "Header",
          cookie: "Cookie",
        };
        if (!types[parameter.in]) {
          error(
            "UNSUPPORTED_PARAMETER",
            `Unsupported parameter location ${parameter.in}`,
            rootUri,
            opPointer,
          );
          continue;
        }
        if (typeof parameter.name !== "string" || !parameter.name) {
          error(
            "INVALID_PARAMETER",
            "A parameter must have a non-empty name",
            rootUri,
            opPointer,
          );
          continue;
        }
        let parameterSchema = parameter.schema;
        let parameterSchemaUri = resolvedParameter.uri;
        let contentMediaType: string | undefined;
        if (parameter.content) {
          const contentTypes = keys(parameter.content);
          if (parameter.schema !== undefined || parameter.style !== undefined || parameter.explode !== undefined || parameter.allowReserved !== undefined || contentTypes.length !== 1) {
            error("INVALID_PARAMETER", `Content-based parameter ${parameter.name} must have one media type and no schema/style`, rootUri, opPointer);
            continue;
          }
          contentMediaType = contentTypes[0];
          const normalizedMediaType = contentMediaType?.split(";", 1)[0]?.trim().toLowerCase();
          if (!normalizedMediaType || !(normalizedMediaType === "application/json" || normalizedMediaType.endsWith("+json") || normalizedMediaType.startsWith("text/") || normalizedMediaType === "application/xml" || normalizedMediaType.endsWith("+xml") || normalizedMediaType === "application/jsonpath")) {
            error("UNSUPPORTED_PARAMETER", `Unsupported parameter media type ${contentMediaType}`, rootUri, opPointer);
            continue;
          }
          const resolvedMedia = deref(parameter.content[contentMediaType!], resolvedParameter.uri);
          parameterSchema = resolvedMedia.value?.schema ?? {};
          parameterSchemaUri = resolvedMedia.uri;
        }
        if (parameter.in === "path" && parameter.required !== true) {
          error(
            "INVALID_PARAMETER",
            `Path parameter ${parameter.name} must be required`,
            rootUri,
            opPointer,
          );
          continue;
        }
        const serialization: Record<string, unknown> = {
          in: parameter.in,
          name: parameter.name,
        };
        if (contentMediaType) serialization.contentMediaType = contentMediaType;
        for (const option of [
          "style",
          "explode",
          "allowReserved",
          "required",
        ]) {
          if (option === "allowReserved" && parameter.in !== "query" && dialect !== "openapi3.2") continue;
          if (parameter[option] !== undefined)
            serialization[option] = parameter[option];
        }
        const collectionFormat = dialect === "swagger2" ? (parameter.collectionFormat ?? (parameter.type === "array" ? "csv" : undefined)) : undefined;
        if (collectionFormat !== undefined) {
          const collectionFormats: Record<
            string,
            { style: string; explode: boolean }
          > = {
            csv: {
              style: parameter.in === "query" ? "form" : "simple",
              explode: false,
            },
            multi: { style: "form", explode: true },
            ssv: { style: "spaceDelimited", explode: false },
            pipes: { style: "pipeDelimited", explode: false },
          };
          const format = collectionFormats[collectionFormat];
          if (
            !format ||
            (collectionFormat !== "csv" && parameter.in !== "query")
          ) {
            error(
              "UNSUPPORTED_PARAMETER",
              `Unsupported collectionFormat ${collectionFormat} for ${parameter.in}`,
              rootUri,
              opPointer,
            );
            continue;
          }
          Object.assign(serialization, format);
        }
        const supportedStyles: Record<string, readonly string[]> = {
          path: ["simple", "label", "matrix"],
          query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
          header: ["simple"],
          cookie: dialect === "openapi3.2" ? ["form", "cookie"] : ["form"],
        };
        const style = serialization.style;
        if (style !== undefined && (typeof style !== "string" || !supportedStyles[parameter.in]!.includes(style))) {
          error("UNSUPPORTED_PARAMETER", `Unsupported ${parameter.in} style ${JSON.stringify(style)} for ${parameter.name}`, resolvedParameter.uri, opPointer);
          continue;
        }
        if ((serialization.explode !== undefined && typeof serialization.explode !== "boolean") || (serialization.allowReserved !== undefined && typeof serialization.allowReserved !== "boolean") || (serialization.required !== undefined && typeof serialization.required !== "boolean")) {
          error("INVALID_PARAMETER", `Parameter ${parameter.name} requires boolean explode, allowReserved and required values`, resolvedParameter.uri, opPointer);
          continue;
        }
        if ((style === "deepObject" && dialect !== "openapi3.2" && serialization.explode !== true) || ((style === "spaceDelimited" || style === "pipeDelimited") && serialization.explode === true)) {
          error("UNSUPPORTED_PARAMETER", `Unsupported explode value for ${parameter.in} parameter ${parameter.name}`, resolvedParameter.uri, opPointer);
          continue;
        }
        if (style === "deepObject" && dialect === "openapi3.2") serialization.explode = true;
        let schema = compile(
          parameterSchema ??
            (dialect === "swagger2"
              ? Object.fromEntries(
                  Object.entries(parameter).filter(([key]) =>
                    [
                      "type",
                      "format",
                      "items",
                      "enum",
                      "default",
                      "minimum",
                      "maximum",
                      "minLength",
                      "maxLength",
                      "pattern",
                      "minItems",
                      "maxItems",
                      "uniqueItems",
                      "multipleOf",
                    ].includes(key),
                  ),
                )
              : {}),
          parameterSchemaUri,
          opPointer,
          "request",
        );
        const contentMedia = contentMediaType?.split(";", 1)[0]?.trim().toLowerCase();
        if (contentMedia && !(contentMedia === "application/json" || contentMedia.endsWith("+json"))) {
          const textSchema = deref(parameterSchema, parameterSchemaUri).value;
          if (object(textSchema) && textSchema.type !== undefined && textSchema.type !== "string" && !(Array.isArray(textSchema.type) && textSchema.type.every((type: unknown) => type === "string"))) {
            error("UNSUPPORTED_PARAMETER", `Text content parameter ${parameter.name} requires a string wire schema`, parameterSchemaUri, opPointer);
            continue;
          }
          schema = `z.intersection(z.string(), ${schema})`;
        }
        if (!parameter.required && parameter.in !== "path")
          schema += ".optional()";
        paramSources.push(
          `{ name: ${safeJson(parameter.name)}, type: ${safeJson(types[parameter.in])}, schema: ${schema}${typeof parameter.description === "string" ? `, description: ${safeJson(parameter.description)}` : ""}, serialization: ${safeJson(serialization)} }`,
        );
      }
      if (formParameters.length) {
        if (paramSources.some((parameter) => parameter.includes('type: "Body"'))) {
          error("INVALID_REQUEST_BODY", "Swagger formData and body parameters cannot be combined", rootUri, opPointer);
        }
        const consumes = op.consumes ?? doc.consumes ?? [formParameters.some((parameter) => parameter.value.type === "file") ? "multipart/form-data" : "application/x-www-form-urlencoded"];
        const schemas: string[] = [];
        for (const mediaType of consumes) {
          const format = requestFormatFor(mediaType);
          if (format !== "form-data" && format !== "form-url") {
            error("UNSUPPORTED_REQUEST_MEDIA", `Swagger formData cannot use ${mediaType}`, rootUri, opPointer);
            continue;
          }
          const fields: string[] = [];
          const encoding: Record<string, { explode: boolean }> = Object.create(null);
          for (const formParameter of formParameters) {
            const field = formParameter.value;
            if (typeof field.name !== "string" || !field.name) {
              error("INVALID_PARAMETER", "A formData parameter requires a name", rootUri, opPointer);
              continue;
            }
            if (field.type === "file" && format !== "form-data") {
              error("UNSUPPORTED_REQUEST_MEDIA", `File field ${field.name} requires multipart/form-data`, rootUri, opPointer);
            }
            const collectionFormat = field.collectionFormat ?? (field.type === "array" ? "csv" : undefined);
            if (collectionFormat !== undefined && !["csv", "multi"].includes(collectionFormat)) {
              error("UNSUPPORTED_REQUEST_ENCODING", `Unsupported form collectionFormat ${collectionFormat}`, rootUri, opPointer);
            }
            if (collectionFormat !== undefined) encoding[field.name] = { explode: collectionFormat === "multi" };
            const fieldSchema = Object.fromEntries(Object.entries(field).filter(([key]) => ["type", "format", "items", "enum", "default", "minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "multipleOf"].includes(key)));
            const expression = compile(fieldSchema, formParameter.uri, opPointer, "request", format === "form-data");
            fields.push(`[${safeJson(field.name)}]: ${expression}${field.required ? "" : ".optional()"}`);
          }
          const schema = `z.object({ ${fields.join(", ")} }).passthrough()`;
          schemas.push(schema);
          requestBodies.push(`{ mediaType: ${safeJson(mediaType)}, schema: ${schema}, required: ${formParameters.some((parameter) => parameter.value.required === true)}${Object.keys(encoding).length ? `, encoding: ${sourceLiteral(encoding)}` : ""} }`);
          requestFormat ??= format;
        }
        const uniqueSchemas = [...new Set(schemas)];
        if (uniqueSchemas.length) {
          const schema = uniqueSchemas.length === 1 ? uniqueSchemas[0] : `z.union([${uniqueSchemas.join(", ")}])`;
          const required = formParameters.some((parameter) => parameter.value.required === true);
          paramSources.push(`{ name: "body", type: "Body", schema: ${schema}${required ? "" : ".optional()"} }`);
        }
      }
      if (op.requestBody) {
        try {
          const resolvedBody = deref(op.requestBody, itemUri);
          const body = resolvedBody.value;
          const content = body?.content ?? {};
          const media = keys(content);
          const bodySchemas: string[] = [];
          const bodyFormats = new Map<string, string>();
          for (const mediaType of media) {
            const resolvedMedia = deref(content[mediaType], resolvedBody.uri);
            const mediaValue = resolvedMedia.value;
            inspectMedia(
              mediaValue,
              resolvedMedia.uri,
              `${resolvedBody.pointer ?? `${opPointer}/requestBody`}/content/${pointerPart(mediaType)}`,
              true,
            );
            const originalEncoding = mediaValue?.encoding;
            const encoding = object(originalEncoding) ? Object.fromEntries(Object.entries(originalEncoding).map(([name, value]) => [name, object(value) ? { ...value } : value])) : originalEncoding;
            if (encoding !== undefined) {
              if (!object(encoding) || !["form-url", "form-data"].includes(requestFormatFor(mediaType) ?? "")) {
                error("UNSUPPORTED_REQUEST_ENCODING", `Encoding is not supported for ${mediaType}`, rootUri, opPointer);
              } else {
                for (const [fieldName, fieldEncoding] of Object.entries(encoding)) {
                  if (!object(fieldEncoding) || Object.keys(fieldEncoding).some((key) => !["contentType", "explode", "style"].includes(key)) || (fieldEncoding.contentType !== undefined && (typeof fieldEncoding.contentType !== "string" || fieldEncoding.contentType.includes(","))) || (fieldEncoding.explode !== undefined && typeof fieldEncoding.explode !== "boolean")) {
                    error("UNSUPPORTED_REQUEST_ENCODING", `Unsupported encoding for field ${fieldName}`, rootUri, opPointer);
                  } else if (fieldEncoding.style !== undefined && !((requestFormatFor(mediaType) === "form-url" && ["form", "spaceDelimited", "pipeDelimited", "deepObject"].includes(fieldEncoding.style)) || (requestFormatFor(mediaType) === "form-data" && fieldEncoding.style === "form"))) {
                    error("UNSUPPORTED_REQUEST_ENCODING", `Unsupported style ${JSON.stringify(fieldEncoding.style)} for field ${fieldName} in ${mediaType}`, rootUri, opPointer);
                  } else if ((fieldEncoding.style === "spaceDelimited" || fieldEncoding.style === "pipeDelimited") && fieldEncoding.explode === true) {
                    error("UNSUPPORTED_REQUEST_ENCODING", `Field ${fieldName}: ${fieldEncoding.style} requires explode=false`, rootUri, opPointer);
                  } else if (fieldEncoding.style === "deepObject" && dialect !== "openapi3.2" && fieldEncoding.explode !== true) {
                    error("UNSUPPORTED_REQUEST_ENCODING", `Field ${fieldName}: deepObject requires explode=true in ${dialect}`, rootUri, opPointer);
                  } else if (fieldEncoding.style === "deepObject" && dialect === "openapi3.2") {
                    fieldEncoding.explode = true;
                  }
                }
              }
            }
            const format = requestMediaFormat(mediaType, mediaValue?.schema, resolvedMedia.uri);
            if (!format) {
              error("UNSUPPORTED_REQUEST_MEDIA", `Unsupported request media ${mediaType}`, rootUri, opPointer);
              continue;
            }
            bodyFormats.set(mediaType, format);
            if (format === "text" && mediaValue?.schema !== undefined) {
              const textSchema = deref(mediaValue.schema, resolvedMedia.uri).value;
              if (object(textSchema) && textSchema.type !== undefined && textSchema.type !== "string" && !(Array.isArray(textSchema.type) && textSchema.type.every((type: unknown) => type === "string"))) {
                error("UNSUPPORTED_REQUEST_MEDIA", `Text media ${mediaType} requires a string wire schema`, resolvedMedia.uri, opPointer);
                continue;
              }
            }
            const compiled = format === "binary" ? binarySchema(mediaValue?.schema, resolvedMedia.uri, "request") : compile(mediaValue?.schema ?? {}, resolvedMedia.uri, opPointer, "request", format === "form-data");
            const bodySchema = format === "text" ? `z.intersection(z.string(), ${compiled})` : compiled;
            bodySchemas.push(bodySchema);
            requestBodies.push(`{ mediaType: ${safeJson(mediaType)}, schema: ${bodySchema}, required: ${body.required === true}${encoding ? `, encoding: ${sourceLiteral(encoding)}` : ""} }`);
          }
          const selected = media.includes("application/json")
            ? "application/json"
            : media[0];
          if (selected) {
            const selectedFormat = bodyFormats.get(selected);
            requestFormat = selectedFormat === "wildcard" ? undefined : selectedFormat;
          }
          if (bodySchemas.length) {
            const uniqueSchemas = [...new Set(bodySchemas)];
            const bodySchema = uniqueSchemas.length === 1 ? uniqueSchemas[0] : `z.union([${uniqueSchemas.join(", ")}])`;
            paramSources.push(
              `{ name: "body", type: "Body", schema: ${bodySchema}${body.required ? "" : ".optional()"} }`,
            );
          }
        } catch (cause) {
          error("REFERENCE_ERROR", String(cause), rootUri, opPointer);
        }
      }
      const responseKeys = keys(op.responses);
      const responseContracts: {
        status: string;
        mediaType?: string;
        schema: string;
        binary?: boolean;
        stream?: "ndjson" | "json-seq" | "sse";
        itemSchema?: string;
      }[] = [];
      const isBinaryMedia = isBinaryMediaType;
      const isTextMedia = (mediaType: string) => { const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase(); return normalized.startsWith("text/") || normalized === "application/xml" || normalized.endsWith("+xml"); };
      for (const status of responseKeys) {
        if (
          !/^[1-5]\d\d$/.test(status) &&
          !/^[1-5]XX$/.test(status) &&
          status !== "default"
        ) {
          error(
            "INVALID_RESPONSE_STATUS",
            `Invalid response status ${status}`,
            rootUri,
            opPointer,
          );
          continue;
        }
        try {
          const resolvedResponse = deref(op.responses[status], itemUri);
          const entry = resolvedResponse.value;
          const bodyless = method === "head" || status === "204" || status === "205";
          if (dialect === "swagger2") {
            const mediaTypes = op.produces ?? doc.produces ?? [];
            const swaggerBinary = (mediaType: string): boolean => {
              const normalized = mediaType.split(";", 1)[0]!.trim().toLowerCase();
              return isBinaryMedia(mediaType) || (!isTextMedia(mediaType) && normalized !== "application/json" && !normalized.endsWith("+json") && explicitBinarySchema(entry?.schema, resolvedResponse.uri));
            };
            const schema = bodyless ? "z.undefined()" : entry?.schema && (!mediaTypes.length || mediaTypes.some((mediaType: string) => !swaggerBinary(mediaType)))
              ? compile(
                  entry.schema,
                  resolvedResponse.uri,
                  opPointer,
                  "response",
                )
              : "z.undefined()";
            if (entry?.schema && mediaTypes.length)
              for (const mediaType of mediaTypes) {
                const binary = !bodyless && swaggerBinary(mediaType);
                responseContracts.push({ status, mediaType, ...(binary ? { binary: true } : {}), schema: binary ? binarySchema(entry.schema, resolvedResponse.uri, "response") : schema });
              }
            else responseContracts.push({ status, schema });
          } else {
            const content = entry?.content ?? {};
            const mediaTypes = keys(content);
            if (!mediaTypes.length)
              responseContracts.push({ status, schema: "z.undefined()" });
            for (const mediaType of mediaTypes) {
              const resolvedMedia = deref(content[mediaType], resolvedResponse.uri);
              const mediaValue = resolvedMedia.value;
              if (bodyless) {
                responseContracts.push({ status, mediaType, schema: "z.undefined()" });
                continue;
              }
              const normalizedMediaType = mediaType.split(";", 1)[0]!.trim().toLowerCase();
              const streamFormat = ["application/x-ndjson", "application/ndjson", "application/jsonl"].includes(normalizedMediaType) ? "ndjson"
                : normalizedMediaType === "application/json-seq" || normalizedMediaType.endsWith("+json-seq") ? "json-seq"
                  : normalizedMediaType === "text/event-stream" ? "sse" : undefined;
              const streaming = !bodyless && mediaValue?.itemSchema !== undefined && streamFormat !== undefined && dialect === "openapi3.2";
              inspectMedia(
                mediaValue,
                resolvedMedia.uri,
                `${resolvedResponse.pointer ?? `${opPointer}/responses/${pointerPart(status)}`}/content/${pointerPart(mediaType)}`,
                false,
                streaming,
              );
              if (streaming) {
                if (mediaValue.schema !== undefined) {
                  error("UNSUPPORTED_MEDIA_FEATURE", "A streaming response with both schema and itemSchema requires whole-stream validation", resolvedResponse.uri, opPointer);
                  continue;
                }
                const itemName = allocate(`${alias}_${status}_StreamItem`, used);
                const itemSchema = compile(mediaValue.itemSchema, resolvedMedia.uri, opPointer, "response");
                streamSchemas.push(`const ${itemName} = ${itemSchema};`);
                responseContracts.push({ status, mediaType, schema: `z.custom<AsyncIterable<z.output<typeof ${itemName}>>>()`, stream: streamFormat, itemSchema: itemName });
                continue;
              }
              if (isTextMedia(mediaType) && mediaValue?.schema !== undefined) {
                const textSchema = deref(mediaValue.schema, resolvedMedia.uri).value;
                if (object(textSchema) && textSchema.type !== undefined && textSchema.type !== "string" && !(Array.isArray(textSchema.type) && textSchema.type.every((type: unknown) => type === "string"))) {
                  error("UNSUPPORTED_RESPONSE_MEDIA", `Text media ${mediaType} requires a string wire schema`, resolvedMedia.uri, opPointer);
                  continue;
                }
              }
              const jsonMedia = normalizedMediaType === "application/json" || normalizedMediaType.endsWith("+json");
              const binary = isBinaryMedia(mediaType) || (!isTextMedia(mediaType) && !jsonMedia && explicitBinarySchema(mediaValue?.schema, resolvedMedia.uri));
              const responseSchema = binary ? binarySchema(mediaValue?.schema, resolvedMedia.uri, "response") : compile(
                mediaValue?.schema ?? {}, resolvedMedia.uri, opPointer, "response",
              );
              responseContracts.push({
                status,
                mediaType,
                ...(binary ? { binary: true } : {}),
                schema: isTextMedia(mediaType) ? `z.intersection(z.string(), ${responseSchema})` : responseSchema,
              });
            }
          }
        } catch (cause) {
          error("REFERENCE_ERROR", String(cause), rootUri, opPointer);
        }
      }
      const successSchemas = [
        ...new Set(
          responseContracts
            .filter(
              (contract) =>
                /^2\d\d$/.test(contract.status) ||
                contract.status === "2XX" ||
                (contract.status === "default" &&
                  !responseKeys.includes("2XX") &&
                  responseKeys.filter((status) => /^2\d\d$/.test(status))
                    .length < 100),
            )
            .map((contract) => contract.schema),
        ),
      ];
      const response =
        successSchemas.length === 0
          ? "z.undefined()"
          : successSchemas.length === 1
            ? successSchemas[0]
            : `z.union([${successSchemas.join(", ")}])`;
      const errors = responseKeys
        .filter((status) => /^[1345](?:\d\d|XX)$/.test(status) || status === "default")
        .map((status) => {
          const schemas = [...new Set(responseContracts.filter(contract => contract.status === status).map(contract => contract.schema))];
          const schema = schemas.length === 0 ? "z.undefined()" : schemas.length === 1 ? schemas[0] : `z.union([${schemas.join(", ")}])`;
          return `{ status: ${/^\d+$/.test(status) ? Number(status) : safeJson(status)}, schema: ${schema} }`;
        });
      const allResponses = responseContracts.map(
        (contract) =>
          `{ status: ${/^\d+$/.test(contract.status) ? Number(contract.status) : safeJson(contract.status)}${contract.mediaType ? `, mediaType: ${safeJson(contract.mediaType)}` : ""}, schema: ${contract.schema}${contract.binary ? ", binary: true" : ""}${contract.stream ? `, stream: ${safeJson(contract.stream)}, itemSchema: ${contract.itemSchema}` : ""} }`,
      );
      const runtimePath = route.replace(
        /\{([^{}]+)\}/g,
        (_match, name: string) => `:${name}`,
      );
      operations.push({
        method,
        path: route,
        alias,
        responses: responseKeys,
        ...(querystring.length ? { querystring } : {}),
      });
      endpointSources.push(
        `  { method: ${safeJson(method)}, path: ${safeJson(runtimePath)}, originalPath: ${safeJson(route)}, alias: ${safeJson(alias)}${operationServer ? `, server: ${safeJson(operationServer)}` : ""}${requestFormat ? `, requestFormat: ${safeJson(requestFormat)}` : ""}${requestBodies.length ? `, requestBodies: [${requestBodies.join(", ")}]` : ""}${security ? `, security: ${sourceLiteral(security)}` : ""}${op.description ? `, description: ${safeJson(op.description)}` : ""}${paramSources.length ? `, parameters: [${paramSources.join(", ")}]` : ""}, response: ${response}, responses: [${allResponses.join(", ")}]${errors.length ? `, errors: [${errors.join(", ")}]` : ""} },`,
      );
    }
  }
  const depends = (
    symbol: { value: any; uri: string },
    seen = new Set<string>(),
  ): Set<string> => {
    if (Array.isArray(symbol.value)) {
      for (const element of symbol.value)
        depends({ value: element, uri: symbol.uri }, seen);
    } else if (object(symbol.value)) {
      if (typeof symbol.value.$ref === "string") {
        try {
          seen.add(resolve(symbol.value.$ref, symbol.uri).canonical);
        } catch {}
      }
      for (const key of keys(symbol.value))
        if (
          !["$ref", "example", "examples", "default", "const", "enum"].includes(
            key,
          )
        )
          depends({ value: symbol.value[key], uri: symbol.uri }, seen);
    }
    return seen;
  };
  const graph = new Map(
    [...symbols].map(([ref, symbol]) => [ref, depends(symbol)]),
  );
  for (const [key, symbol] of projectedSymbols)
    graph.set(
      key,
      new Set(
        [...depends(symbol)].map(
          (reference) => `${symbol.direction}${symbol.binaryInput ? "-binary" : ""}|${reference}`,
        ),
      ),
    );
  const sameValueReferences = (value: unknown, uri: string, references = new Set<string>()): Set<string> => {
    if (!object(value)) return references;
    if (typeof value.$ref === "string") {
      try { references.add(resolve(value.$ref, uri).canonical); } catch {}
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (Array.isArray(value[key])) for (const branch of value[key]) sameValueReferences(branch, uri, references);
    }
    for (const key of ["not", "if", "then", "else"]) sameValueReferences(value[key], uri, references);
    if (object(value.dependentSchemas)) for (const branch of Object.values(value.dependentSchemas)) sameValueReferences(branch, uri, references);
    return references;
  };
  const sameValueGraph = new Map([...symbols].map(([key, symbol]) => [key, sameValueReferences(symbol.value, symbol.uri)]));
  for (const [key, symbol] of projectedSymbols) sameValueGraph.set(key, new Set([...sameValueReferences(symbol.value, symbol.uri)].map(reference => `${symbol.direction}${symbol.binaryInput ? "-binary" : ""}|${reference}`)));
  const cycleMembers = (dependencies: Map<string, Set<string>>): Set<string> => {
    const indices = new Map<string, number>();
    const lowLinks = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    const members = new Set<string>();
    let nextIndex = 0;
    const visit = (key: string): void => {
      indices.set(key, nextIndex);
      lowLinks.set(key, nextIndex++);
      stack.push(key);
      onStack.add(key);
      for (const dependency of dependencies.get(key) ?? []) {
        if (!dependencies.has(dependency)) continue;
        if (!indices.has(dependency)) {
          visit(dependency);
          lowLinks.set(key, Math.min(lowLinks.get(key)!, lowLinks.get(dependency)!));
        } else if (onStack.has(dependency)) lowLinks.set(key, Math.min(lowLinks.get(key)!, indices.get(dependency)!));
      }
      if (lowLinks.get(key) !== indices.get(key)) return;
      const component: string[] = [];
      let member: string;
      do { member = stack.pop()!; onStack.delete(member); component.push(member); } while (member !== key);
      if (component.length > 1 || dependencies.get(key)?.has(key)) for (const entry of component) members.add(entry);
    };
    for (const key of dependencies.keys()) if (!indices.has(key)) visit(key);
    return members;
  };
  const sameValueCycles = cycleMembers(sameValueGraph);
  for (const [key, symbol] of symbols) if (sameValueCycles.has(key))
    error("UNSUPPORTED_SCHEMA_RECURSION", "A schema reference cycle re-evaluates the same value without traversing a property or array item", symbol.uri, symbol.fragment);
  for (const [key, symbol] of projectedSymbols) if (sameValueCycles.has(key))
    error("UNSUPPORTED_SCHEMA_RECURSION", "A projected schema reference cycle re-evaluates the same value without traversing a property or array item", symbol.uri, symbol.fragment);
  const recursiveMembers = cycleMembers(graph);
  for (const [ref, symbol] of symbols)
    expressions.set(ref, compileRaw(symbol.value, symbol.uri, symbol.fragment));
  for (const [key, symbol] of projectedSymbols)
    expressions.set(
      key,
      compileRaw(symbol.value, symbol.uri, symbol.fragment, symbol.direction, symbol.binaryInput),
    );
  const bindings = [...referenceBindings].map(
    ([ref, binding]) => {
      const symbol = (symbols.get(ref) ?? projectedSymbols.get(ref))!;
      return `const ${binding}${recursiveMembers.has(ref) ? `: z.ZodType<${symbol.name}, ${symbol.name}>` : ""} = z.lazy(() => ${symbol.name});`;
    },
  );
  const recursiveType = (symbol: { value: any; uri: string; direction?: ProjectionDirection; binaryInput?: boolean }): string => inferSchemaType(symbol.value, (reference) => {
    try {
      const target = resolve(reference, symbol.uri);
      const key = symbol.direction ? `${symbol.direction}${symbol.binaryInput ? "-binary" : ""}|${target.canonical}` : target.canonical;
      return symbol.direction ? projectedSymbols.get(key)?.name : symbols.get(key)?.name;
    } catch { return undefined; }
  }, { dialect: dialect === "swagger2" ? "3.0" : dialect.replace("openapi", "") as "3.0" | "3.1" | "3.2", binaryInput: symbol.binaryInput });
  const declarations = [...symbols].map(
    ([ref, symbol]) => {
      const recursive = recursiveMembers.has(ref);
      const type = recursive ? recursiveType(symbol) : `z.output<typeof ${symbol.name}>`;
      const expression = options.compileSchemas && !recursive ? `z.compile(${expressions.get(ref)})` : expressions.get(ref);
      return `export type ${symbol.name} = ${type};\nexport const ${symbol.name} = ${expression}${recursive ? ` as unknown as z.ZodType<${symbol.name}, ${symbol.name}>` : ""};`;
    },
  );
  for (const [key, symbol] of projectedSymbols)
    {
      const recursive = recursiveMembers.has(key);
      const type = recursive ? recursiveType(symbol) : `z.output<typeof ${symbol.name}>`;
      const expression = options.compileSchemas && !recursive ? `z.compile(${expressions.get(key)})` : expressions.get(key);
      declarations.push(`type ${symbol.name} = ${type};\nconst ${symbol.name} = ${expression}${recursive ? ` as unknown as z.ZodType<${symbol.name}, ${symbol.name}>` : ""};`);
    }
  const exported = [...symbols.values()].map((symbol) => symbol.name);
  const schemasLine = `export const schemas = { ${exported.join(", ")} };`;
  const sourceUri = sourceBases.get(doc) ?? rootUri;
  let swaggerBaseUrl = "";
  if (dialect === "swagger2" && !options.schemaOnly) {
    const retrieval = /^https?:/i.test(sourceUri) ? new URL(sourceUri) : undefined;
    const scheme = (Array.isArray(doc.schemes) && doc.schemes[0]) || retrieval?.protocol.slice(0, -1) || "https";
    const basePath = typeof doc.basePath === "string" ? doc.basePath : "";
    if (options.baseUrl === undefined && !/^(?:http|https)$/i.test(String(scheme))) {
      error("UNSUPPORTED_SERVER_SCHEME", `Axios cannot use Swagger scheme ${JSON.stringify(scheme)}`, sourceUri, "/schemes");
    }
    if (doc.basePath !== undefined && (typeof doc.basePath !== "string" || !doc.basePath.startsWith("/"))) {
      error("INVALID_BASE_PATH", "Swagger basePath must be a string beginning with /", sourceUri, "/basePath");
    }
    if (doc.host) swaggerBaseUrl = `${scheme}://${doc.host}${basePath}`;
    else if (retrieval) swaggerBaseUrl = `${scheme}://${retrieval.host}${basePath || "/"}`;
    else swaggerBaseUrl = basePath;
  }
  const baseUrl = options.baseUrl ?? (dialect === "swagger2" ? swaggerBaseUrl : (defaultServer ?? ""));
  const outputPath = options.outputFile ?? "client.ts";
  const standaloneDirectory = path.posix.join(path.posix.dirname(outputPath), "otsc-runtime");
  const serverDefinitions = dialect === "swagger2"
    ? [{ url: baseUrl || "/" }]
    : Array.isArray(doc.servers) && doc.servers.length ? doc.servers : [{ url: "/" }];
  const source = [
    `import { z } from 'zod';`,
    ...[...validators]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([digest, validator]) =>
          `import { validate as ${validator.binding} } from './otsc-validator-${digest}.mjs';`,
      ),
    ...(options.schemaOnly
      ? []
      : [`import { makeApi, Otsc, type OtscOptions } from '${options.standalone ? "./otsc-runtime/index.mjs" : "otsc"}';`]),
    "",
    ...(validators.size ? [`const ${issuePathBinding} = (value: unknown, pointer: string): (string | number)[] => { let current: unknown = value; return pointer ? pointer.slice(1).split("/").map((part) => { const key = part.replace(/~1/g, "/").replace(/~0/g, "~"); const segment = Array.isArray(current) && /^(0|[1-9]\\d*)$/.test(key) ? Number(key) : key; current = current !== null && typeof current === "object" ? (current as Record<string | number, unknown>)[segment] : undefined; return segment; }) : []; };`] : []),
    ...(validators.size ? [`const ${wireValidationBinding} = <Schema extends z.ZodType>(schema: Schema, validate: ((value: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; message?: string; params: Record<string, unknown> }[] | null }): z.ZodType<z.output<Schema>, z.input<Schema>> => z.unknown().superRefine((value, context) => { if (validate(value)) return; const issues = validate.errors; if (!issues?.length) { context.addIssue({ code: "custom", message: "JSON Schema validation failed" }); return; } for (const issue of issues) { const path = ${issuePathBinding}(value, issue.instancePath); const property = issue.keyword === "required" || issue.keyword === "dependentRequired" ? issue.params.missingProperty : issue.keyword === "additionalProperties" ? issue.params.additionalProperty : issue.keyword === "unevaluatedProperties" ? issue.params.unevaluatedProperty : issue.keyword === "propertyNames" ? issue.params.propertyName : undefined; if (typeof property === "string") path.push(property); context.addIssue({ code: "custom", path, message: issue.message ?? "JSON Schema validation failed" }); } }).pipe(schema) as unknown as z.ZodType<z.output<Schema>, z.input<Schema>>;`] : []),
    ...bindings,
    ...declarations,
    ...streamSchemas,
    schemasLine,
    ...(!options.schemaOnly ? [`export const servers = ${sourceLiteral(serverDefinitions)} as const;`] : []),
    ...(options.schemaOnly
      ? []
      : [
          "",
          "export const endpoints = makeApi([",
          ...endpointSources,
          "] as const);",
          `export const createApiClient = (baseURL?: string, options?: OtscOptions) => new Otsc(baseURL ?? ${safeJson(baseUrl)}, endpoints, { useOperationServers: baseURL === undefined && ${options.baseUrl === undefined}, ...options });`,
        ]),
    "",
  ].join("\n");
  let runtimeFiles: GeneratedFile[] = [];
  if (options.standalone && !options.schemaOnly) {
    try {
      runtimeFiles = await emitStandaloneRuntime({ outputDir: standaloneDirectory });
    } catch (cause) {
      error("STANDALONE_RUNTIME_ERROR", cause instanceof Error ? cause.message : String(cause));
    }
  }
  const files: GeneratedFile[] = diagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  )
    ? []
    : [
        { path: outputPath, content: source },
        ...runtimeFiles,
        ...[...validators]
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .flatMap(([digest, validator]) => {
            const directory = path.posix.dirname(outputPath);
            const basename = `otsc-validator-${digest}`;
            return [
              {
                path: path.posix.join(directory, `${basename}.mjs`),
                content: `export const validate = ${validator.code};\n`,
              },
              {
                path: path.posix.join(directory, `${basename}.d.mts`),
                content:
                  "export declare const validate: ((value: unknown) => boolean) & { errors?: readonly { instancePath: string; keyword: string; message?: string; params: Record<string, unknown> }[] | null };\n",
              },
            ];
          }),
      ];
  const contracts: ContractInspection = {
    schemas: [...symbols].map(([ref, symbol]) => ({
      name: symbol.name,
      reference: logicalUri(splitRef(ref)[0]) + splitRef(ref)[1],
    })),
    operations,
  };
  return {
    files,
    diagnostics,
    contracts,
    manifest: {
      formatVersion: 1,
      generator: "otsc",
      optionsHash: hash(stable(Object.fromEntries(Object.entries(options).filter(([key]) => !["loadResource", "allowNetwork", "maxResources", "maxResourceBytes", "resourceTimeoutMs", "allowedProtocols"].includes(key))))),
      inputs: [...resources.values()]
        .map((resource) => ({
          uri: logicalUri(resource.uri),
          sha256: resource.digest,
          ...(resource.baseUri === resource.uri ? {} : { baseUri: resource.baseUri }),
        }))
        .sort((left, right) =>
          left.uri < right.uri ? -1 : left.uri > right.uri ? 1 : 0,
        ),
      outputs: files.map((file) => ({
        path: file.path,
        sha256: hash(file.content),
      })),
    },
  };
}

/** Write generated files atomically one at a time, or inspect drift with check/dryRun. */
export async function writeGeneratedFiles(
  result: GenerationResult,
  options: WriteOptions = {},
): Promise<WriteResult> {
  if (result.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    throw new Error("Cannot write generation result containing errors");
  const root = path.resolve(options.outputDir ?? ".");
  const written: string[] = [],
    unchanged: string[] = [],
    changed: string[] = [];
  async function verifyPath(
    target: string,
    generatedPath: string,
  ): Promise<void> {
    const relative = path.relative(root, target);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = root;
    for (const segment of [undefined, ...segments]) {
      if (segment !== undefined) current = path.join(current, segment);
      try {
        const information = await lstat(current);
        if (information.isSymbolicLink())
          throw new Error(
            `Generated path ${generatedPath} traverses a symbolic link: ${current}`,
          );
      } catch (cause: any) {
        if (cause?.code === "ENOENT") break;
        throw cause;
      }
    }
  }
  const targets = new Set<string>();
  const pending: { file: GeneratedFile; target: string }[] = [];
  for (const file of result.files) {
    const target = path.resolve(root, file.path);
    const relative = path.relative(root, target);
    if (
      path.isAbsolute(file.path) ||
      target === root ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      targets.has(target)
    )
      throw new Error(`Invalid or duplicate generated path: ${file.path}`);
    targets.add(target);
    await verifyPath(target, file.path);
    let existing: string | undefined;
    try {
      existing = await readFile(target, "utf8");
    } catch (cause: any) {
      if (cause?.code !== "ENOENT") throw cause;
    }
    if (existing === file.content) unchanged.push(file.path);
    else {
      changed.push(file.path);
      pending.push({ file, target });
    }
  }
  if (options.check || options.dryRun) return { written, unchanged, changed };
  const staged: { file: GeneratedFile; target: string; temporary: string }[] =
    [];
  try {
    for (const entry of pending) {
      await mkdir(path.dirname(entry.target), { recursive: true });
      await verifyPath(entry.target, entry.file.path);
      const temporary = `${entry.target}.${randomUUID()}.tmp`;
      await writeFile(temporary, entry.file.content, { flag: "wx" });
      staged.push({ ...entry, temporary });
    }
    for (const entry of staged) {
      await verifyPath(entry.target, entry.file.path);
      await rename(entry.temporary, entry.target);
      written.push(entry.file.path);
    }
  } finally {
    await Promise.all(
      staged.map((entry) => unlink(entry.temporary).catch(() => {})),
    );
  }
  return { written, unchanged, changed };
}
