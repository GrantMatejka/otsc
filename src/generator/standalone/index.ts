import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { GeneratedFile } from "../index.js";

export interface StandaloneRuntimeOptions {
  /** Relative directory in the generated output. Defaults to "otsc-runtime". */
  outputDir?: string;
}

/**
 * Return the installed package's bundled ESM runtime and its declarations.
 * Generated clients should import `<outputDir>/index.mjs` and provide axios and
 * zod as dependencies. No files are written by this function.
 */
export async function emitStandaloneRuntime(
  options: StandaloneRuntimeOptions = {},
): Promise<GeneratedFile[]> {
  const outputDir = options.outputDir ?? "otsc-runtime";
  // Use portable, unambiguous output paths even when generating on another OS.
  if (
    !outputDir ||
    outputDir.includes("\\") ||
    outputDir.includes("\0") ||
    path.posix.isAbsolute(outputDir) ||
    path.win32.isAbsolute(outputDir) ||
    outputDir.split("/").some((part) =>
      !part || part === "." || part === ".." ||
      /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
    )
  ) {
    throw new Error(`Invalid standalone runtime output directory: ${JSON.stringify(outputDir)}`);
  }

  // The generator can be bundled as either ESM or CJS. Resolve through the
  // current module, never through the caller's working directory.
  const requireFromHere = createRequire(
    typeof __filename === "string" ? __filename : import.meta.url,
  );
  const packageRoot = path.dirname(requireFromHere.resolve("otsc/package.json"));
  const declarationsRoot = path.join(packageRoot, "dist", "types", "esm");
  const files: GeneratedFile[] = [];
  const add = (relativePath: string, content: string): void => {
    files.push({ path: `${outputDir}/${relativePath}`, content });
  };

  add("index.mjs", (await readFile(path.join(packageRoot, "dist", "index.js"), "utf8")).replace(/\n\/\/# sourceMappingURL=.*(?:\n|$)/, "\n"));
  add("LICENSE", await readFile(path.join(packageRoot, "LICENSE"), "utf8"));

  async function addDeclaration(relativePath: string): Promise<void> {
    const content = await readFile(path.join(declarationsRoot, ...relativePath.split("/")), "utf8");
    // Keep external imports intact; only relative module specifiers reference
    // the relocated declaration graph.
    const rewritten = content.replace(
      /((?:from\s+|import\s*\()\s*["'])(\.{1,2}\/[^"']+)\.js(["'])/g,
      "$1$2.mjs$3",
    );
    add(relativePath.replace(/\.d\.ts$/, ".d.mts"), rewritten);
  }

  async function addDirectory(relativeDir: string): Promise<void> {
    const entries = await readdir(path.join(declarationsRoot, ...relativeDir.split("/")), { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relativePath = `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) await addDirectory(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".d.ts")) await addDeclaration(relativePath);
    }
  }

  await addDeclaration("index.d.ts");
  await addDirectory("runtime");
  await addDirectory("serialization");
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return files;
}
