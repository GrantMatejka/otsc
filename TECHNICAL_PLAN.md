# OTSC technical plan

## Goal and scope

Produce reproducible TypeScript Axios clients and public Zod 4 schemas from OpenAPI descriptions. Support common outbound HTTP operations in Swagger 2.0 and OpenAPI 3.0, 3.1 and 3.2, with faithful wire behavior and useful inferred types. The runtime, generator and compatibility entry point should be usable independently.

Prioritize established client and generator behavior and ordinary real-world specifications. Webhooks, callbacks, response links, universal custom dialects, lossless JSON number parsing and specialized streaming formats are optional extensions, not release blockers. An unsupported construct must produce a clear diagnostic when ignoring it would change behavior.

## Current state

- The package contains an Axios runtime, Zod 4 schema compiler, generator, compatibility entry point, CLI, standalone output, deterministic manifests and reference locks.
- The generator handles common operations, request and response contracts, security, server selection, serialization, schema projection and several streaming formats. Coverage is incomplete; accepting a version number is not a claim that every feature in that version works.
- Ajv is a build-time dependency. Standalone generated validators handle composition, conditional, dependency and evaluation-related constraints, including constraints reached through references, and report Zod issues with paths while preserving Zod input and output types. Format assertions are opt-in for OpenAPI 3.1 and 3.2. The emitted client does not need Ajv to compile schemas at runtime. Static anchors are supported in the fallback; dynamic references remain limited across the full generator pipeline.
- Standalone validation considers own object properties only, matching JSON object semantics for property names inherited from JavaScript prototypes.
- Explicit properties whose names conflict with Object.prototype produce a diagnostic: Zod currently reads inherited values or discards `__proto__`. Open objects can still lose an undeclared `__proto__` property during Zod parsing; a wire-preserving object representation that retains useful public schema APIs remains unfinished.
- Binary request and response generation and buffered Axios decoding cover common binary media, explicitly marked binary schemas, and mixed JSON/text responses. OpenAPI 3.2 byte-length limits are enforced; unsupported constraints are diagnosed rather than ignored. Explicit Axios transport or transformation settings remain under caller control.
- The generator resolves common embedded schema IDs and anchors, respects OpenAPI 3.2 document base URIs and HTTP redirects, emits Zod metadata and tuple types, and accepts a custom resource loader with an offline mode. Redirect targets are recorded in reference locks. Full dynamic scope and broad schema conformance still need work.
- The modern generator and CLI support opt-in limits on resource count and size, HTTP timeouts, and permitted URI schemes. Redirects are checked against the permitted schemes before following them. Loader policy does not alter the reference-lock options hash.
- Absent OpenAPI server lists default to the specification origin when the source is an HTTP URL. Swagger host and scheme defaults are inherited from the source URL.
- Server templates validate their own braces before variable substitution; unsupported non-HTTP server schemes are diagnosed unless a base URL override is supplied.
- Generated error contracts include status classes, default responses and media unions. Common XML and text payloads are handled as strings; XML object serialization remains outside that support.
- Generated named schemas also export their TypeScript types. Recursive schemas retain conservative named types instead of defaulting to `any`; complex constraints still require a type-quality audit.
- Recursive object types reflect required undeclared properties, additional-property schemas, and applicable property patterns. Legacy reference siblings are ignored consistently by both validation and type inference.
- Generated request types distinguish required from optional bodies and permit per-request Axios base URL overrides.
- Read-method helpers accept declared request bodies, including QUERY; `httpOptions` provides an OPTIONS helper alongside the existing `options` property. Generated aliases are allocated around client method names, and manually supplied reserved aliases are rejected before they can overwrite client methods.
- Stream-capable responses can share an operation with buffered JSON successes or errors; support still depends on an Axios adapter that supplies readable byte streams.
- Buffering a non-streaming response from a streaming adapter copies chunks and honors the merged Axios maxContentLength setting.
- SSE parsing carries the last event ID across events and ID-only blocks. Reconnection and independent ID-change notifications remain outside the stream parser.
- JSON response strings are decoded once for success and error contracts. Multipart object fields are emitted as JSON parts, including repeated object array parts.
- URL-encoded fields support explicit form, space-delimited, pipe-delimited and deep-object styles as well as explode; Swagger 2 array parameters and form fields default to comma-separated serialization. Multipart supports explicit form-style expansion for flat scalar values. Explicit reserved expansion and other multipart styles remain unsupported.
- Context-based compatibility generation resolves common nested external references and redirects. Its synchronous helpers still require bundled documents, and schema resource scopes remain limited in that profile.
- Compatibility dependency discovery includes schema composition and conditional locations, including meaningful siblings of modern references, to preserve recursive declarations.
- Compatibility groups expose client factories as well as preconstructed clients, including exports from multi-file indexes. Explicit empty base URLs remain usable as overrides.
- Compatibility operations retain separate request-body contracts for their supported media types; a request with multiple choices selects one through its Content-Type header.
- Grouped and template-based compatibility endpoints carry inherited or operation-specific security requirements and supported security schemes.
- Compatibility context generation accepts OpenAPI 3.2 and QUERY operations while diagnosing unsupported 3.2 features, including whole-query parameters, streaming, additional operations and `$self`.
- Modern OpenAPI 3.2 whole-query form parameters support field encoding metadata and the supported URL-encoded styles.
- Request and response contract selection honors media ranges and declared parameters, preferring the most specific matching contract.
- Bodyless HEAD, 204 and 205 responses do not require a Content-Type for contract selection; equally specific response media matches are diagnosed as ambiguous.
- Wildcard request-body ranges can select supported concrete media through Content-Type; binary schemas retain transport-aware handling.
- Schema-only generation scans component schemas independently of unrelated operations and their references.
- Request validation and security selection account for Axios default headers and basic authentication; supplied credentials take precedence over configured providers. Default Content-Type headers also select the corresponding request-body contract.
- When multiple security alternatives are satisfiable, an alternative containing a caller-supplied credential takes precedence over configured providers.
- Path serialization supports OpenAPI 3.2 reserved expansion while retaining escaped path and style delimiters.
- Mixed declared and undeclared path parameters are substituted in a single pass, and request/response projection carries inherited property annotations into dependent schemas while diagnosing ambiguous cases.
- Projection diagnoses additional ambiguous read/write annotations in conditional schemas; nested conditional compositions still need an audit.
- Unsupported parameter styles and explode combinations are diagnosed during generation; space-delimited and pipe-delimited query serialization supports arrays and flat objects. OpenAPI 3.2 deep-object serialization ignores explode as specified.
- Reference-object sibling behavior is version-aware: Swagger 2.0 and OpenAPI 3.0 ignore siblings, while OpenAPI 3.1 and 3.2 retain JSON Schema sibling constraints.
- OpenAPI 3.1 and 3.2 reference objects preserve summary and description overrides; parameter descriptions are included in generated endpoint metadata.
- Schema resource lookup recognizes percent-encoded pointers and named anchors consistently with reference resolution.
- Static pointer resolution updates the canonical URI and base as it crosses nested schema resource identifiers; dynamic scope is still unsupported.
- Integer schemas accept all integer-valued JavaScript numbers; lossless representation of JSON integers outside the safe range remains optional work.
- Build and typecheck pass, and limited smoke checks have run. Existing tests are not a complete feature-parity or conformance audit.
- Runtime and compatibility names are OTSC names. No project-specific names or references should be introduced.

## Design decisions

### Ajv and Zod responsibilities

Use Ajv as the primary evaluator of JSON Schema validation semantics whenever a schema has semantics that need more than a straightforward Zod representation. Prefer its standalone compiler at generation time. Zod remains the public schema API and supplies inferred input and output types, parsing, transforms and the integration with the Axios runtime.

1. Preserve a faithful wire schema and its resource graph. Compile it with the Ajv instance for its actual dialect after explicit OpenAPI-specific normalization.
2. Generate a Zod representation that retains useful structural type information. Run the Ajv validator on the raw wire value before transformations or stripping. A Zod parse must not reject a value that the selected wire schema permits; identify and fix mappings that cannot satisfy this rule.
3. Native Zod-only validation is appropriate when the mapping is demonstrably equivalent and gives a simpler generated client. Use Ajv for evaluation-dependent, conditional and other difficult constraints rather than reimplementing their evaluation.
4. Generate standalone validators and deduplicate equivalent validators deterministically. Do not require runtime compilation or dynamic evaluation in generated clients. Measure generated size; provide a shared runtime or configurable mode only if it proves worthwhile.
5. Keep coercion, property removal and default insertion disabled in wire validation. Treat format as an annotation by default for applicable dialects; make format assertions explicit. Specify integer and decimal behavior rather than silently losing precision.
6. Translate Ajv errors into actionable Zod issues with instance paths and useful messages. Preserve Zod input/output distinctions and do not claim exact static types for constraints TypeScript cannot represent.
7. Preserve dialect distinctions: OpenAPI 3.0 Schema Objects are not interchangeable with draft 2020-12; Swagger 2.0 and OpenAPI 3.0 need carefully scoped adapters. Do not simply relabel their schemas as a newer dialect.
8. Handle non-JSON values such as Blob and multipart file data at the transport boundary. Ajv JSON-value validation cannot directly replace validation of those values.

The current Ajv wrapper restricts resource and dynamic-reference support. Remove restrictions only after preserving resource identity, base URI, dynamic scope and request/response projection end to end. Ajv's support alone does not make our loader or generated types correct.

### Deliverable boundaries

- Root package: browser-compatible runtime with Axios and Zod.
- Generator entry: Node-only loading, schema compilation, diagnostics and optional writing.
- Compatibility entry: established generator options, hooks and return shapes where compatible with the OTSC public naming policy.
- CLI: deterministic generation, reference locks, check mode and explicit diagnostics.
- Generated output: ordinary TypeScript and Zod schemas, with the runtime imported or emitted standalone.

## Remaining work, in priority order

### 1. Establish the behavior inventory

- Enumerate runtime builders, public types, constructors, methods, aliases, plugins, error helpers and configuration behavior. Record each as implemented, partial or missing, with a concrete example and source location.
- Enumerate generator options, extension hooks, grouping strategies, template context, schema/type exports, status/media selection, CLI flags and return shapes. Record intended behavior separately for modern and compatibility entry points.
- Identify migration differences caused by the OTSC naming policy. Avoid reintroducing names or references that the user asked to remove.
- Track unresolved behavior as issues or a machine-readable checklist. Do not claim parity based merely on exported names.

Acceptance: a reviewer can identify the expected behavior and current status of every public entry point and option.

### 2. Make Ajv the reliable wire-validation boundary

- Audit existing native mappings and categorize them as exact, type-only plus Ajv, or unsupported. Cover oneOf exclusivity, combinators with siblings, conditionals, dependencies, object/array evaluation, structural equality, Unicode strings and numbers.
- Resolve Zod object parsing of prototype-named properties, including passthrough `__proto__`, while preserving wire values, input/output types and useful object schema APIs. Remove the explicit-property diagnostic only after that behavior is correct.
- Expand standalone Ajv routing to suitable difficult constructs while keeping the Zod type shape useful. For each rule removed from native Zod evaluation, ensure the complete original constraint reaches Ajv and is evaluated before Zod transformations.
- Ensure referenced constraints are included even when the triggering keyword occurs only in a referenced schema. Keep recursive graphs finite and deterministic.
- Integrate normalized schema resources into Ajv without rewriting references in ways that break base URI, anchor or dynamic scope. Register resources by canonical URI and preserve nested resource boundaries.
- Verify Ajv support and limitations for nested identifiers, anchors, dynamic references and standalone generation against representative resource graphs before removing explicit guards. If unsupported, report a source-located diagnostic.
- Normalize OpenAPI 3.0 and Swagger 2.0 semantics separately, including nullable, exclusive bounds and composition. Preserve readOnly/writeOnly request/response projections without changing unrelated schema behavior.
- Implement explicit format assertion configuration and stable error mapping. Keep validator setup side-effect free and deterministic; cache or share validator outputs by stable schema identity.
- Replace custom evaluation code with Ajv where safe and useful. Retain native Zod validation where it is equivalent and improves the public schema or type.
- Handle non-JSON and multipart data in a distinct transport-aware validation path. Do not blindly run a JSON validator on Blob, FormData or stream instances.

Acceptance: supported schemas validate wire values consistently with their dialect; generated validators are usable in the intended environments without runtime schema compilation.

### 3. Correct reference loading and reproducibility

- Resolve local, relative-file and HTTP references from the correct base. Distinguish OpenAPI Reference Objects from schema references and preserve meaningful siblings.
- Integrate the existing resource index with loading, compilation and projection, including $id and $anchor. Handle dynamic scope through the evaluator where supported.
- Follow references only in valid reference positions; never fetch reference-looking data in examples, defaults or vendor extensions.
- Verify authenticated custom loaders, in-memory documents, offline workflows, resource limits, allowed protocols and timeouts across all supported resource kinds. Add cancellation support for custom loaders if needed.
- Keep hashes and logical URIs stable across machines. Frozen locks must fail on missing or changed resources; generation must not make untracked secondary lookups.
- Diagnose missing resources, cycles and unsupported scopes with URI, pointer and reference chain.

Acceptance: a pinned multi-file specification can be regenerated consistently without network access when the required resources are supplied.

### 4. Complete outbound HTTP execution

- Audit all HTTP methods and aliases, including request option and return-type inference, supplied Axios instances, base URL precedence and plugin ordering.
- Complete path, query, header and cookie serialization for common OpenAPI styles, requiredness, reserved characters and content-based parameters. Preserve exact wire names and mixed path segments.
- Complete JSON, text, binary, URL-encoded and multipart request handling, including per-part metadata supported by the transport. Select and validate the schema for the actual content type.
- Implement binary responses using Axios response types and transport-aware validation. Define mixed JSON/binary response behavior and user overrides.
- Validate success and error responses against the selected status and media contract; normalize HEAD and bodyless statuses. Preserve original Axios errors and expose actionable validation errors.
- Audit API-key, basic, bearer and OAuth/OIDC credentials, AND/OR requirements, async providers and security overrides. Treat credential acquisition and token refresh as application concerns unless explicitly configured.
- Ensure runtime behavior is sensible across browser and Node adapters; diagnose unsupported transport behavior instead of silently changing requests.

Acceptance: representative generated clients issue the expected request bytes and select the correct response contract on both supported transport environments.

### 5. Finish generator and compatibility behavior

- Complete options for aliases, schema and type exports, object policy, default values, descriptions, deprecation, status/media selection and grouping.
- Complete custom templates, Handlebars helpers, schema refiners, endpoint refiners and compatibility return shapes. Document the supported predicate expression language and fail clearly for unsupported expressions.
- Handle external references consistently in compatibility generation. Remove synchronous-helper limitations only where the API can do so without hidden I/O.
- Emit stable, collision-free names for schemas, operations, paths and grouped files. Handle cyclic references and cross-file dependencies without initialization-order failures.
- Generate accurate request/response input and output types, including optional bodies, read/write projections, error contracts and declared media. Preserve public Zod schema usability.
- Keep schema-only output free of the Axios runtime; ensure standalone output has matching runtime declarations and license.

Acceptance: each supported option and extension has a defined observable result, and generated code compiles and can execute for representative inputs.

### 6. Diagnostics and output management

- Reject unsupported schema, media, serialization and transport constructs when silently accepting them would misrepresent the contract. Include the document location and a practical explanation.
- Distinguish warnings from errors and expose structured diagnostics through both API and CLI. Avoid printing or writing files in the pure generation API.
- Ensure check, dry-run, atomic output writing, path safety and locks agree on the same deterministic output. Prevent stale generated files from being mistaken for current output.

Acceptance: errors explain what cannot be generated and where; repeated generation with identical inputs produces identical files and manifest.

### 7. Verification and release readiness

The immediate priority is implementation; defer a comprehensive test campaign until the core behavior is in place. Keep builds, typechecks and small targeted smoke checks running as changes are made.

Before claiming parity or publishing:

- Add focused characterization coverage for the behavior inventory, generator options, templates, public types and plugin ordering.
- Compare validation behavior against relevant official JSON Schema fixtures and targeted OpenAPI examples, particularly resource scopes, dialect differences, compositions and projections. Test both accepted and rejected values.
- Compile and execute generated clients against a local HTTP server, covering request bytes, authentication, errors, binary content and response selection. Test both ESM and CommonJS package consumers and standalone output.
- Run the supported Node, browser, TypeScript, Zod and Axios version matrix; select peer ranges based on demonstrated compatibility.
- Check npm package contents, declaration resolution, reproducibility, output size and generation performance. Update documentation and examples only if explicitly requested.

Acceptance: a published compatibility report identifies supported and unsupported behavior and the release gates pass.

## Optional work after the outbound client

- Export webhook and callback contracts for server-side or reverse-direction use.
- Add response-header and link modeling where there is a clear consumer use case.
- Extend streaming formats and whole-stream validation where the relevant Axios adapters support them.
- Support custom JSON Schema vocabularies or additional dialects through a documented plugin boundary.
- Add opt-in lossless numeric parsing and codecs with matching inbound and outbound transport behavior.
