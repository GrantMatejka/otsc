export function isBinaryMediaType(value: string | undefined): boolean {
  if (!value) return false;
  const media = value.split(';', 1)[0]!.trim().toLowerCase();
  if (media.endsWith('+xml') || media.endsWith('+json')) return false;
  return media === 'application/octet-stream' || /^(?:image|audio|video)\//.test(media) ||
    ['application/pdf', 'application/zip', 'application/gzip', 'application/x-protobuf', 'application/protobuf', 'application/wasm'].includes(media);
}

/** Match a declared media range against a concrete Content-Type, including parameters. */
export function mediaMatchScore(pattern: string, contentType: string): readonly [number, number] | undefined {
  const parse = (input: string) => {
    const parts: string[] = [];
    let start = 0, quoted = false, escaped = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
      else if (char === ";" && !quoted) { parts.push(input.slice(start, i)); start = i + 1; }
    }
    if (quoted || escaped) return undefined;
    parts.push(input.slice(start));
    const type = parts.shift()!.trim().toLowerCase();
    const parameters = new Map<string, string>();
    for (const part of parts) {
      const index = part.indexOf("=");
      if (index < 1) return undefined;
      const name = part.slice(0, index).trim().toLowerCase();
      let value = part.slice(index + 1).trim();
      if (!name || !value || parameters.has(name)) return undefined;
      if (value.startsWith('"')) {
        if (!value.endsWith('"') || value.length < 2) return undefined;
        value = value.slice(1, -1).replace(/\\(.)/g, "$1");
      }
      parameters.set(name, name === "charset" ? value.toLowerCase() : value);
    }
    return { type, parameters };
  };
  const declared = parse(pattern), actual = parse(contentType);
  if (!declared || !actual) return undefined;
  const specificity = declared.type === actual.type ? 3 : declared.type === "*/*" ? 1 :
    declared.type.endsWith("/*") && actual.type.startsWith(declared.type.slice(0, -1)) ? 2 : 0;
  if (!specificity) return undefined;
  for (const [name, value] of declared.parameters) if (actual.parameters.get(name) !== value) return undefined;
  return [specificity, declared.parameters.size];
}
