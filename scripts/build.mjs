import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { build } from "esbuild";

const entries = {
  index: "src/index.ts",
  "generator/index": "src/generator/index.ts",
  "compat/index": "src/compat/index.ts",
  cli: "src/cli.ts",
};

await rm("dist", { recursive: true, force: true });

await Promise.all(
  ["esm", "cjs"].map((format) =>
    build({
      entryPoints: format === "cjs"
        ? Object.fromEntries(Object.entries(entries).filter(([name]) => name !== "cli"))
        : entries,
      outdir: "dist",
      outExtension: { ".js": format === "esm" ? ".js" : ".cjs" },
      bundle: true,
      packages: "external",
      platform: "neutral",
      target: "es2022",
      format,
      sourcemap: true,
      logOverride: format === "cjs" ? { "empty-import-meta": "silent" } : {},
    }),
  ),
);

const compiler = spawnSync("tsc", ["--emitDeclarationOnly"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (compiler.error) throw compiler.error;
if (compiler.status !== 0) process.exit(compiler.status ?? 1);

async function copyDeclarations(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    if (entry.isDirectory()) {
      await copyDeclarations(sourcePath, path.join(destination, entry.name));
    } else if (entry.name.endsWith(".d.ts")) {
      const declaration = await readFile(sourcePath, "utf8");
      const commonjs = declaration.replace(
        /((?:from\s+|import\s*\()\s*["'])(\.{1,2}\/[^"']+)\.js(["'])/g,
        "$1$2.cjs$3",
      );
      await writeFile(path.join(destination, entry.name.replace(/\.d\.ts$/, ".d.cts")), commonjs);
    } else {
      await cp(sourcePath, path.join(destination, entry.name));
    }
  }
}

await copyDeclarations("dist/types/esm", "dist/types/cjs");
