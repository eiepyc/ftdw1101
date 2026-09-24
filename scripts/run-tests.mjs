import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

const files = testFiles(resolve("tests")).sort();
if (files.length === 0) {
  console.error("No .test.ts files were found under tests/.");
  process.exit(1);
}

const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const result = spawnSync(process.execPath, [tsxCli, "--test", ...files], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
