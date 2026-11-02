import { parseAsync, type $ZodType, type output } from "zod/v4/core";

export type StreamingBody = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

export interface StreamingOptions {
  signal?: AbortSignal;
}

export interface ServerSentEvent {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

export class StreamingCapabilityError extends Error {
  constructor() {
    super("Axios response data is not a readable byte stream; select an adapter that supports responseType: 'stream'.");
    this.name = "StreamingCapabilityError";
  }
}

export class StreamingParseError extends Error {
  readonly format: string;
  readonly record: number;

  constructor(format: string, record: number, message: string, cause?: unknown) {
    super(`${format} record ${record}: ${message}`, { cause });
    this.name = "StreamingParseError";
    this.format = format;
    this.record = record;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The stream was aborted", "AbortError");
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === "object" && value !== null && typeof (value as ReadableStream<Uint8Array>).getReader === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && typeof (value as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function";
}

export async function* streamBytes(body: unknown, options: StreamingOptions = {}): AsyncGenerator<Uint8Array> {
  const signal = options.signal;
  if (!isReadableStream(body) && !isAsyncIterable(body)) throw new StreamingCapabilityError();

  const reader = isReadableStream(body) ? body.getReader() : undefined;
  const iterator = reader ? undefined : (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  let complete = false;
  let abortListener: (() => void) | undefined;
  const aborted = signal && new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      if (reader) void reader.cancel(abortReason(signal)).catch(() => undefined);
      if (iterator) {
        const destroy = (body as { destroy?: () => unknown }).destroy;
        if (typeof destroy === "function") destroy.call(body);
        else if (iterator.return) void Promise.resolve(iterator.return()).catch(() => undefined);
      }
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });

  if (aborted) void aborted.catch(() => undefined);

  try {
    while (true) {
      if (signal?.aborted) throw abortReason(signal);
      const pending = reader ? reader.read() : iterator!.next();
      const result = aborted ? await Promise.race([pending, aborted]) : await pending;
      if (signal?.aborted) throw abortReason(signal);
      if (result.done) {
        complete = true;
        return;
      }
      if (!(result.value instanceof Uint8Array)) throw new TypeError("Stream chunks must be Uint8Array values.");
      yield result.value;
    }
  } finally {
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
    if (reader) {
      if (!complete && !signal?.aborted) await reader.cancel();
      reader.releaseLock();
    } else if (!complete && !signal?.aborted && iterator?.return) {
      await iterator.return();
    }
  }
}

async function* streamText(body: unknown, options: StreamingOptions): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for await (const chunk of streamBytes(body, options)) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) yield text;
  }
  const finalText = decoder.decode();
  if (finalText) yield finalText;
}

async function* streamLines(body: unknown, options: StreamingOptions): AsyncGenerator<string> {
  let buffer = "";
  let afterCarriageReturn = false;
  for await (const text of streamText(body, options)) {
    for (const character of text) {
      if (afterCarriageReturn) {
        afterCarriageReturn = false;
        if (character === "\n") continue;
      }
      if (character === "\r" || character === "\n") {
        yield buffer;
        buffer = "";
        afterCarriageReturn = character === "\r";
      } else {
        buffer += character;
      }
    }
  }
  if (buffer) yield buffer;
}

function parseJson(text: string, format: string, record: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new StreamingParseError(format, record, "invalid or incomplete JSON", cause);
  }
}

export async function* parseNdjson(body: unknown, options: StreamingOptions = {}): AsyncGenerator<unknown> {
  let record = 0;
  for await (const line of streamLines(body, options)) {
    if (!line.trim()) continue;
    record += 1;
    yield parseJson(line, "NDJSON", record);
  }
}

export async function* parseJsonSequence(body: unknown, options: StreamingOptions = {}): AsyncGenerator<unknown> {
  let buffer = "";
  let started = false;
  let record = 0;
  const parseRecord = (text: string): unknown => {
    record += 1;
    const value = parseJson(text, "JSON text sequence", record);
    if (typeof value === "number" && !text.endsWith("\n")) {
      throw new StreamingParseError("JSON text sequence", record, "a number must end with a line feed to detect truncation");
    }
    return value;
  };
  for await (const text of streamText(body, options)) {
    let offset = 0;
    while (true) {
      const separator = text.indexOf("\u001e", offset);
      if (separator < 0) {
        buffer += text.slice(offset);
        break;
      }
      buffer += text.slice(offset, separator);
      if (started && buffer.trim()) yield parseRecord(buffer);
      else if (!started && buffer.trim()) throw new StreamingParseError("JSON text sequence", 1, "expected a record separator");
      started = true;
      buffer = "";
      offset = separator + 1;
    }
  }
  if (!started && buffer.trim()) throw new StreamingParseError("JSON text sequence", 1, "expected a record separator");
  if (started && buffer.trim()) yield parseRecord(buffer);
}

export async function* parseSse(body: unknown, options: StreamingOptions = {}): AsyncGenerator<ServerSentEvent> {
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;
  let record = 0;
  for await (const line of streamLines(body, options)) {
    if (line === "") {
      if (data.length) {
        record += 1;
        yield { data: data.join("\n"), ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }), ...(retry === undefined ? {} : { retry }) };
      }
      data = [];
      event = undefined;
      retry = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "retry" && /^\d+$/.test(value)) {
      const milliseconds = Number(value);
      if (!Number.isSafeInteger(milliseconds)) throw new StreamingParseError("SSE", record + 1, "retry exceeds the safe integer range");
      retry = milliseconds;
    }
  }
}

export async function* validateStream<Schema extends $ZodType>(items: AsyncIterable<unknown>, schema: Schema): AsyncGenerator<output<Schema>> {
  for await (const item of items) yield await parseAsync(schema, item);
}

export async function* parseSseJson(body: unknown, options: StreamingOptions = {}): AsyncGenerator<unknown> {
  let record = 0;
  for await (const event of parseSse(body, options)) {
    record += 1;
    yield parseJson(event.data, "SSE", record);
  }
}
