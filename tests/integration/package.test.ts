import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);

it("ships loadable ESM and CommonJS entry points with usable declarations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "otsc-package-"));
  try {
    const packed = await execute("npm", ["pack", "--json", "--pack-destination", directory], { cwd: process.cwd() });
    const packageName = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "otsc-consumer", private: true, type: "module" }));
    await execute("npm", ["install", "--offline", "--ignore-scripts", "--no-audit", path.join(directory, packageName)], { cwd: directory });
    await execute(process.execPath, ["--input-type=module", "-e", "import { Otsc } from 'otsc'; import { generateClient } from 'otsc/generator'; if (!Otsc || !generateClient) process.exit(1)"], { cwd: directory });
    await execute(process.execPath, ["-e", "if (!require('otsc').Otsc || !require('otsc/generator').generateClient || !require('otsc/compat').generateZodClientFromOpenAPI) process.exit(1)"], { cwd: directory });

    await writeFile(path.join(directory, "consumer.mts"), `import { makeApi, Otsc } from 'otsc';
import { z } from 'zod';
const api = makeApi([{ method: 'get', path: '/pets/:id', alias: 'getPet', parameters: [{ name: 'id', type: 'Path', schema: z.string() }], response: z.string() }]);
const client = new Otsc(api);
client.getPet({ params: { id: 'pet' } });
// @ts-expect-error id must be a string
client.getPet({ params: { id: 42 } });
`);
    await writeFile(path.join(directory, "consumer.cts"), `import runtime = require('otsc');
import zod = require('zod');
const api = runtime.makeApi([{ method: 'get', path: '/pets/:id', alias: 'getPet', parameters: [{ name: 'id', type: 'Path', schema: zod.z.string() }], response: zod.z.string() }]);
const client = new runtime.Otsc(api);
client.getPet({ params: { id: 'pet' } });
// @ts-expect-error id must be a string
client.getPet({ params: { id: 42 } });
`);
    const compiler = path.join(process.cwd(), "node_modules", ".bin", "tsc");
    await execute(compiler, ["--ignoreConfig", "--noEmit", "--strict", "--skipLibCheck", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", path.join(directory, "consumer.mts"), path.join(directory, "consumer.cts")], { cwd: directory })
      .catch((error: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`);
      });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
