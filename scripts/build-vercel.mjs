import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const nextCli = resolve("node_modules/next/dist/bin/next");
const result = spawnSync(process.execPath, [nextCli, "build"], {
  stdio: "inherit",
  env: { ...process.env, VERCEL_BUILD: "1" },
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
