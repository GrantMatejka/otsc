import { serializeQueryParameter, type ParameterValue } from "../../serialization/index.js";

export type RequestBodyFieldEncoding = {
  contentType?: string;
  explode?: boolean;
  style?: "form" | "spaceDelimited" | "pipeDelimited" | "deepObject";
};

export type EncodeRequestBodyOptions = {
  mediaType: string;
  encoding?: Readonly<Record<string, RequestBodyFieldEncoding>>;
};

export type EncodedRequestBody = {
  data: string | Blob | ArrayBuffer | ArrayBufferView | FormData;
  headers: Record<string, string>;
  removeContentType: boolean;
};

type FieldValue = unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isBlob(value: unknown): value is Blob {
  return typeof Blob !== "undefined" && value instanceof Blob;
}

function isBinary(value: unknown): value is Blob | ArrayBuffer | ArrayBufferView {
  return isBlob(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function json(value: unknown, name: string): string {
  let result: string | undefined;
  try {
    result = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${name} cannot be JSON serialized: ${String(error)}`);
  }
  if (result === undefined) throw new TypeError(`${name} cannot be JSON serialized`);
  return result;
}

function scalar(value: unknown, name: string): string {
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new TypeError(`${name} must be a string, finite number, or boolean`);
}

function fieldText(value: unknown, name: string, contentType?: string): string {
  const type = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (type === "application/json" || type?.endsWith("+json")) return json(value, name);
  if (isRecord(value) || Array.isArray(value) || value === null) {
    if (contentType) throw new TypeError(`${name} requires a scalar for ${contentType}`);
    return json(value, name);
  }
  return scalar(value, name);
}

function fields(value: unknown, name: string): Record<string, FieldValue> {
  if (!isRecord(value)) throw new TypeError(`${name} must be a plain object`);
  return value;
}

function formUrlEncoded(value: unknown, encoding: EncodeRequestBodyOptions["encoding"]): string {
  if (typeof URLSearchParams === "undefined") throw new Error("Form encoding requires URLSearchParams support");
  if (value instanceof URLSearchParams) {
    if (encoding && Object.keys(encoding).length) throw new TypeError("Field encoding cannot be applied to an existing URLSearchParams body");
    return value.toString();
  }
  const params = new URLSearchParams();
  const chunks: string[] = [];
  const flush = () => {
    const text = params.toString();
    if (text) chunks.push(text);
    for (const key of [...params.keys()]) params.delete(key);
  };
  for (const [name, entry] of Object.entries(fields(value, "Form body"))) {
    if (entry === undefined) continue;
    const options = encoding?.[name];
    if (options?.style !== undefined) {
      flush();
      if (options.style === "spaceDelimited") {
        if (options.explode === true) throw new TypeError(`Form field ${JSON.stringify(name)}: spaceDelimited requires explode=false`);
        const encodePart = (part: string) => new URLSearchParams([["", part]]).toString().slice(1);
        const field = `Form field ${JSON.stringify(name)}`;
        const values = Array.isArray(entry) ? entry.map(item => scalar(item, field)) : isRecord(entry)
          ? Object.keys(entry).sort().flatMap(key => [key, scalar(entry[key], field)]) : undefined;
        if (!values?.length) throw new TypeError(`${field}: spaceDelimited requires a non-empty array or flat object`);
        chunks.push(`${encodePart(name)}=${values.map(encodePart).join("%20")}`);
      } else {
        chunks.push(serializeQueryParameter({ name, style: options.style, explode: options.explode, pointer: `Form field ${JSON.stringify(name)}` }, entry as ParameterValue).replace(/%20/g, "+").replace(/~/g, "%7E").replace(/,/g, "%2C"));
      }
      continue;
    }
    // An explicit explode selects form-style expansion, which takes
    // precedence over a field's contentType serialization.
    if (options?.explode !== undefined) {
      const field = `Form field ${JSON.stringify(name)}`;
      if (Array.isArray(entry)) {
        const values = entry.filter(item => item !== undefined).map(item => scalar(item, field));
        if (options.explode) for (const item of values) params.append(name, item);
        else params.append(name, values.join(","));
      } else if (isRecord(entry)) {
        const entries = Object.entries(entry).filter(([, item]) => item !== undefined);
        if (options.explode) for (const [key, item] of entries) params.append(key, scalar(item, field));
        else params.append(name, entries.flatMap(([key, item]) => [key, scalar(item, field)]).join(","));
      } else params.append(name, scalar(entry, field));
      continue;
    }
    if (Array.isArray(entry)) {
      const values = entry.filter((item) => item !== undefined).map((item) => fieldText(item, `Form field ${JSON.stringify(name)}`, options?.contentType));
      if (options?.explode === false) params.append(name, values.join(","));
      else for (const item of values) params.append(name, item);
    } else {
      params.append(name, fieldText(entry, `Form field ${JSON.stringify(name)}`, options?.contentType));
    }
  }
  flush();
  return chunks.filter(Boolean).join("&");
}

function multipart(value: unknown, encoding: EncodeRequestBodyOptions["encoding"]): FormData {
  if (typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw new Error("Multipart encoding requires native FormData and Blob support");
  }
  const form = new FormData();
  const ancestors = new Set<object>();
  function append(name: string, entry: unknown, options?: RequestBodyFieldEncoding): void {
    if (entry === undefined) return;
    const contentType = options?.contentType;
    if (contentType) {
      let part: Blob;
      if (isBlob(entry)) part = new Blob([entry], { type: contentType });
      else if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) {
        const bytes = entry instanceof ArrayBuffer ? new Uint8Array(entry) : new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);
        part = new Blob([new Uint8Array(bytes)], { type: contentType });
      } else {
        const type = contentType.split(";", 1)[0].trim().toLowerCase();
        const text = Array.isArray(entry) && options?.explode === false && type !== "application/json" && !type.endsWith("+json")
          ? entry.map((item) => scalar(item, `Multipart field ${JSON.stringify(name)}`)).join(",")
          : fieldText(entry, `Multipart field ${JSON.stringify(name)}`, contentType);
        part = new Blob([text], { type: contentType });
      }
      if (isBlob(entry) && typeof File !== "undefined" && entry instanceof File) form.append(name, part, entry.name);
      else form.append(name, part);
      return;
    }
    if (isBlob(entry)) {
      form.append(name, entry);
    } else if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) {
      const bytes = entry instanceof ArrayBuffer ? new Uint8Array(entry) : new Uint8Array(entry.buffer, entry.byteOffset, entry.byteLength);
      form.append(name, new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }));
    } else if (isRecord(entry)) {
      form.append(name, new Blob([json(entry, `Multipart field ${JSON.stringify(name)}`)], { type: "application/json" }));
    } else if (Array.isArray(entry)) {
      if (ancestors.has(entry)) throw new TypeError(`Multipart field ${JSON.stringify(name)} is circular`);
      ancestors.add(entry);
      if (options?.explode === false) {
        form.append(name, entry.map((item) => scalar(item, `Multipart field ${JSON.stringify(name)}`)).join(","));
      } else {
        for (const item of entry) append(name, item);
      }
      ancestors.delete(entry);
    } else if (entry === null) {
      form.append(name, "null");
    } else {
      form.append(name, scalar(entry, `Multipart field ${JSON.stringify(name)}`));
    }
  }
  for (const [name, entry] of Object.entries(fields(value, "Multipart body"))) {
    const options = encoding?.[name];
    if (entry === undefined) continue;
    if (options?.style !== undefined || options?.explode !== undefined) {
      const field = `Multipart field ${JSON.stringify(name)}`;
      if (options.style !== undefined && options.style !== "form") {
        throw new TypeError(`${field}: unsupported multipart style ${JSON.stringify(options.style)}`);
      }
      const explode = options.explode ?? true;
      if (Array.isArray(entry)) {
        const values = entry.filter(item => item !== undefined).map(item => scalar(item, field));
        if (explode) for (const item of values) form.append(name, item);
        else form.append(name, values.join(","));
      } else if (isRecord(entry)) {
        const entries = Object.entries(entry).filter(([, item]) => item !== undefined);
        if (explode) for (const [key, item] of entries) form.append(key, scalar(item, field));
        else form.append(name, entries.flatMap(([key, item]) => [key, scalar(item, field)]).join(","));
      } else {
        form.append(name, scalar(entry, field));
      }
      continue;
    }
    if (Array.isArray(entry) && options?.contentType && options.explode !== false) {
      for (const item of entry) append(name, item, options);
    } else append(name, entry, options);
  }
  return form;
}

export function encodeRequestBody(value: unknown, options: EncodeRequestBodyOptions): EncodedRequestBody {
  const mediaType = options.mediaType.split(";", 1)[0].trim().toLowerCase();
  if (!mediaType) throw new TypeError("Request body media type is required");
  if (mediaType === "multipart/form-data") {
    if (options.mediaType.includes(";")) throw new TypeError("Multipart media type parameters must be generated by the transport");
    if (typeof FormData !== "undefined" && value instanceof FormData) {
      if (options.encoding && Object.keys(options.encoding).length) throw new TypeError("Part encoding cannot be applied to an existing FormData body");
      return { data: value, headers: {}, removeContentType: true };
    }
    return { data: multipart(value, options.encoding), headers: {}, removeContentType: true };
  }
  let data: EncodedRequestBody["data"];
  if (mediaType === "application/json" || mediaType.endsWith("+json")) {
    data = json(value, "Request body");
  } else if (mediaType.startsWith("text/") || mediaType === "application/xml" || mediaType.endsWith("+xml")) {
    if (typeof value !== "string") throw new TypeError(`${options.mediaType} body must be a string`);
    data = value;
  } else if (mediaType === "application/x-www-form-urlencoded") {
    data = formUrlEncoded(value, options.encoding);
  } else if (mediaType === "application/octet-stream") {
    if (!isBinary(value)) throw new TypeError("Binary body must be a Blob, ArrayBuffer, or ArrayBuffer view");
    data = binaryBody(value);
  } else if (isBinary(value)) {
    data = binaryBody(value);
  } else {
    throw new TypeError(`Unsupported request body media type ${JSON.stringify(options.mediaType)}`);
  }
  return { data, headers: { "Content-Type": options.mediaType }, removeContentType: false };
}

// Axios' default request transform sends the entire backing buffer of a view.
// Copy views so slices and pooled buffers cannot expose unrelated bytes.
function binaryBody(value: Blob | ArrayBuffer | ArrayBufferView): Blob | ArrayBuffer {
  if (!ArrayBuffer.isView(value)) return value;
  return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)).buffer;
}
