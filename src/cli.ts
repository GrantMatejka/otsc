#!/usr/bin/env node
import path from "node:path";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { generateClient, writeGeneratedFiles } from "./generator/index.js";
import { createReferenceLock, verifyReferenceLock } from "./generator/lock.js";
import { generateZodClientFromOpenAPI, type TemplateContextOptions } from "./compat/index.js";
import { resolveConfig } from "prettier";

interface CliOptions {
  input?: string;
  output?: string;
  baseUrl?: string;
  serverIndex?: number;
  serverVariables?: Record<string, string>;
  writeLock?: string;
  frozenLock?: string;
  profile?: "modern" | "compat";
  template?: string;
  prettier?: string;
  compatibilityOptions: TemplateContextOptions;
  schemaOnly: boolean;
  standalone: boolean;
  compileSchemas: boolean;
  offline: boolean;
  assertFormats: boolean;
  maxResources?: number;
  maxResourceBytes?: number;
  resourceTimeoutMs?: number;
  allowedProtocols?: string[];
  check: boolean;
  dryRun: boolean;
  jsonDiagnostics: boolean;
  help: boolean;
  version: boolean;
}

const help = `Usage: otsc <input> [options]

Generate a TypeScript and Zod Axios client from a JSON or YAML OpenAPI document.

Options:
  -o, --output <file>       Output file (defaults to <input>.client.ts)
  -b, --base-url <url>      Override the API base URL
      --server-index <n>    Select a server from each applicable server list
      --server-variable <name=value>  Override a server variable (repeatable)
      --schema-only         Generate schemas without the Axios client
      --standalone          Emit the client runtime alongside generated files
      --compile-schemas     Opt in to compiled Zod parsers
      --offline             Disable HTTP resource loading
      --max-resources <n>   Limit the number of loaded resources
      --max-resource-bytes <n>  Limit the UTF-8 size of each resource
      --resource-timeout <ms>  Set the HTTP request timeout
      --allow-protocol <scheme>  Restrict resource schemes (repeatable)
      --assert-formats      Validate supported JSON Schema formats
      --check               Check whether generated output is up to date
      --dry-run             Report changes without writing files
      --write-lock <file>   Write a lock for resolved inputs and options
      --frozen-lock <file>  Require resolved inputs and options to match a lock
      --profile <name>      Select modern or compat generation
  -t, --template <file>     Use a custom compatibility template
      --group-strategy <name>  Group output by tag or method
      --export-schemas      Export all named schemas
      --export-types        Export schema types
      --with-docs           Include generated type documentation
      --with-description    Include schema descriptions
      --with-deprecated     Include deprecated operations
      --strict-objects      Reject additional object properties
      --all-readonly        Generate readonly objects and arrays
      --diagnostics <kind>  Output diagnostics as text or json
  -h, --help                Show help
  -v, --version             Show version
`;

function parseArguments(argumentsList: readonly string[]): CliOptions {
  const options: CliOptions = {
    schemaOnly: false,
    standalone: false,
    compileSchemas: false,
    offline: false,
    assertFormats: false,
    check: false,
    dryRun: false,
    jsonDiagnostics: false,
    compatibilityOptions: {},
    help: false,
    version: false,
  };
  const valueOptions = new Set(["-o", "--output", "-b", "--base-url", "--diagnostics", "--write-lock", "--frozen-lock", "--server-index", "--server-variable", "--profile", "-t", "--template", "-p", "--prettier", "--api-client-name", "--error-expr", "--success-expr", "--media-type-expr", "--group-strategy", "--complexity-threshold", "--default-status", "--additional-props-default-value", "--max-resources", "--max-resource-bytes", "--resource-timeout", "--allow-protocol"]);
  const compatibilityFlags: Record<string, keyof TemplateContextOptions> = {
    "--export-schemas": "shouldExportAllSchemas",
    "--export-types": "shouldExportAllTypes",
    "--implicit-required": "withImplicitRequiredProps",
    "--with-deprecated": "withDeprecatedEndpoints",
    "--with-description": "withDescription",
    "--with-docs": "withDocs",
    "--all-readonly": "allReadonly",
    "--strict-objects": "strictObjects",
    "--with-alias": "withAlias",
    "-a": "withAlias",
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]!;
    const separator = argument.startsWith("--") ? argument.indexOf("=") : -1;
    const name = separator === -1 ? argument : argument.slice(0, separator);
    let value = separator === -1 ? undefined : argument.slice(separator + 1);
    if (valueOptions.has(name)) {
      value ??= argumentsList[++index];
      if (value === undefined || value === "") throw new Error(`Missing value for ${name}`);
      if (name === "-o" || name === "--output") options.output = value;
      else if (name === "-b" || name === "--base-url") options.baseUrl = value;
      else if (name === "--write-lock") options.writeLock = value;
      else if (name === "--frozen-lock") options.frozenLock = value;
      else if (name === "--profile") {
        if (value !== "modern" && value !== "compat") throw new Error("--profile must be modern or compat");
        options.profile = value;
      } else if (name === "-t" || name === "--template") options.template = value;
      else if (name === "-p" || name === "--prettier") options.prettier = value;
      else if (name === "--api-client-name") options.compatibilityOptions.apiClientName = value;
      else if (name === "--error-expr") options.compatibilityOptions.isErrorStatus = value;
      else if (name === "--success-expr") options.compatibilityOptions.isMainResponseStatus = value;
      else if (name === "--media-type-expr") options.compatibilityOptions.isMediaTypeAllowed = value;
      else if (name === "--group-strategy") {
        if (!["none", "tag", "method", "tag-file", "method-file"].includes(value)) throw new Error("Unsupported group strategy");
        options.compatibilityOptions.groupStrategy = value as TemplateContextOptions["groupStrategy"];
      } else if (name === "--complexity-threshold") {
        const threshold = Number(value);
        if (!Number.isSafeInteger(threshold)) throw new Error("--complexity-threshold must be an integer");
        options.compatibilityOptions.complexityThreshold = threshold;
      } else if (name === "--default-status") {
        if (value !== "spec-compliant" && value !== "auto-correct") throw new Error("Unsupported default status behavior");
        options.compatibilityOptions.defaultStatusBehavior = value;
      } else if (name === "--additional-props-default-value") {
        if (value !== "true" && value !== "false") throw new Error("--additional-props-default-value must be true or false");
        options.compatibilityOptions.additionalPropertiesDefaultValue = value === "true";
      }
      else if (name === "--server-index") {
        const index = Number(value);
        if (!Number.isSafeInteger(index) || index < 0) throw new Error("--server-index must be a non-negative integer");
        options.serverIndex = index;
      } else if (name === "--server-variable") {
        const assignment = value.indexOf("=");
        if (assignment <= 0) throw new Error("--server-variable must have the form name=value");
        options.serverVariables ??= Object.create(null) as Record<string, string>;
        options.serverVariables[value.slice(0, assignment)] = value.slice(assignment + 1);
      }
      else if (name === "--allow-protocol") {
        if (!/^[a-z][a-z0-9+.-]*:?$/i.test(value)) throw new Error("--allow-protocol requires a URI scheme");
        (options.allowedProtocols ??= []).push(value);
      } else if (name === "--max-resources" || name === "--max-resource-bytes" || name === "--resource-timeout") {
        const limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || (name === "--resource-timeout" && limit > 0x7fffffff)) throw new Error(`${name} requires a positive integer in the supported range`);
        if (name === "--max-resources") options.maxResources = limit;
        else if (name === "--max-resource-bytes") options.maxResourceBytes = limit;
        else options.resourceTimeoutMs = limit;
      }
      else {
        if (value !== "text" && value !== "json") throw new Error("--diagnostics must be text or json");
        options.jsonDiagnostics = value === "json";
      }
      continue;
    }
    if (value !== undefined) throw new Error(`Unknown option ${name}`);
    if (name in compatibilityFlags) Object.assign(options.compatibilityOptions, { [compatibilityFlags[name]!]: true });
    else if (name === "--no-with-alias") options.compatibilityOptions.withAlias = false;
    else if (name === "--schema-only") options.schemaOnly = true;
    else if (name === "--standalone") options.standalone = true;
    else if (name === "--compile-schemas") options.compileSchemas = true;
    else if (name === "--offline") options.offline = true;
    else if (name === "--assert-formats") options.assertFormats = true;
    else if (name === "--check") options.check = true;
    else if (name === "--dry-run") options.dryRun = true;
    else if (name === "-h" || name === "--help") options.help = true;
    else if (name === "-v" || name === "--version") options.version = true;
    else if (name.startsWith("-")) throw new Error(`Unknown option ${name}`);
    else if (options.input) throw new Error(`Unexpected input ${name}`);
    else options.input = name;
  }
  return options;
}

function defaultOutput(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    const name = path.basename(new URL(input).pathname) || "openapi";
    return `${name}.client.ts`;
  }
  if (input.startsWith("file:")) return `${fileURLToPath(input)}.client.ts`;
  return `${input}.client.ts`;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
    return;
  }
  const packageFile = new URL("../package.json", import.meta.url);
  const packageMetadata = JSON.parse(await readFile(packageFile, "utf8")) as { version: string };
  if (options.version) {
    process.stdout.write(`${packageMetadata.version}\n`);
    return;
  }
  if (!options.input) throw new Error("An input document is required. Run otsc --help for usage.");
  if (options.writeLock && options.frozenLock) throw new Error("Use either --write-lock or --frozen-lock, not both");
  if (options.writeLock && options.check) throw new Error("--write-lock cannot be combined with --check");
  const output = path.resolve(options.output ?? defaultOutput(options.input));
  const hasCompatibilityOptions = !!options.template || !!options.prettier || Object.keys(options.compatibilityOptions).length > 0;
  if (options.profile === "modern" && hasCompatibilityOptions) throw new Error("Compatibility options require --profile compat");
  if (options.profile === "compat" || hasCompatibilityOptions) {
    if (options.schemaOnly || options.standalone || options.compileSchemas || options.writeLock || options.frozenLock || options.offline || options.assertFormats || options.serverIndex !== undefined || options.serverVariables || options.maxResources || options.maxResourceBytes || options.resourceTimeoutMs || options.allowedProtocols) {
      throw new Error("Schema-only, standalone, resource loading, server selection, and lock options require the modern profile");
    }
    const compatibilityOptions = { withAlias: true, ...options.compatibilityOptions, baseUrl: options.baseUrl };
    const generated = await generateZodClientFromOpenAPI({
      openApiDoc: options.input,
      disableWriteToFile: true,
      options: compatibilityOptions,
      templatePath: options.template,
      prettierConfig: options.prettier ? await resolveConfig(options.prettier) : null,
    });
    const grouped = typeof generated !== "string";
    const files = typeof generated === "string" ? [{ path: path.basename(output), content: generated }] : Object.entries(generated).map(([name, content]) => ({
      path: name === "__index" ? "index.ts" : name === "__common" ? "common.ts" : `${name}.ts`, content,
    }));
    const written = await writeGeneratedFiles({
      files, diagnostics: [], contracts: { schemas: [], operations: [] },
      manifest: { formatVersion: 1, generator: "otsc", optionsHash: "", inputs: [], outputs: [] },
    }, { outputDir: grouped ? output : path.dirname(output), check: options.check, dryRun: options.dryRun });
    if (options.check && written.changed.length) process.exitCode = 1;
    if (options.jsonDiagnostics) process.stdout.write("[]\n");
    else if (written.changed.length) for (const filename of written.changed) process.stdout.write(`${options.check || options.dryRun ? "Would write" : "Wrote"} ${path.join(grouped ? output : path.dirname(output), filename)}\n`);
    else process.stdout.write("Generated output is up to date.\n");
    return;
  }
  const result = await generateClient(options.input, {
    outputFile: path.basename(output),
    baseUrl: options.baseUrl,
    serverIndex: options.serverIndex,
    serverVariables: options.serverVariables,
    schemaOnly: options.schemaOnly,
    standalone: options.standalone,
    compileSchemas: options.compileSchemas,
    allowNetwork: !options.offline,
    assertFormats: options.assertFormats,
    maxResources: options.maxResources,
    maxResourceBytes: options.maxResourceBytes,
    resourceTimeoutMs: options.resourceTimeoutMs,
    allowedProtocols: options.allowedProtocols,
  });
  const diagnostics = [...result.diagnostics];
  const lock = createReferenceLock(result.manifest, packageMetadata.version);
  if (options.frozenLock) {
    try {
      const expected = JSON.parse(await readFile(options.frozenLock, "utf8")) as unknown;
      verifyReferenceLock(lock, expected);
    } catch (error) {
      diagnostics.push({ code: "LOCK_MISMATCH", severity: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }
  if (options.jsonDiagnostics) {
    process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
  } else {
    for (const diagnostic of diagnostics) {
      const location = diagnostic.location ? ` ${diagnostic.location.uri}${diagnostic.location.pointer}` : "";
      process.stderr.write(`${diagnostic.severity}: ${diagnostic.code}${location}: ${diagnostic.message}\n`);
    }
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    process.exitCode = 1;
    return;
  }
  const written = await writeGeneratedFiles(result, {
    outputDir: path.dirname(output),
    check: options.check,
    dryRun: options.dryRun,
  });
  if (options.writeLock && !options.dryRun) {
    const lockPath = path.resolve(options.writeLock);
    const temporaryPath = `${lockPath}.${process.pid}.tmp`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });
      await rename(temporaryPath, lockPath);
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
  if (options.check && written.changed.length > 0) process.exitCode = 1;
  if (!options.jsonDiagnostics) {
    for (const filename of written.changed) {
      process.stdout.write(`${options.check || options.dryRun ? "Would write" : "Wrote"} ${path.join(path.dirname(output), filename)}\n`);
    }
    if (written.changed.length === 0) process.stdout.write("Generated output is up to date.\n");
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
