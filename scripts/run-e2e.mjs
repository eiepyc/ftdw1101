import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3400";
const parsedBase = new URL(baseURL);
if (parsedBase.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(parsedBase.hostname) ||
    parsedBase.pathname !== "/" || parsedBase.search || parsedBase.hash) {
  console.error("End-to-end tests may target only a local HTTP origin.");
  process.exit(2);
}
const port = parsedBase.port || "80";
const builtServer = resolve(".next/standalone/server.js");
if (!existsSync(builtServer)) {
  console.error("Run npm run build before npm run test:e2e.");
  process.exit(1);
}

const preparation = spawn(process.execPath, [resolve("scripts/prepare-standalone.mjs")], { stdio: "inherit", windowsHide: true });
const preparationCode = await new Promise((resolveCode, reject) => {
  preparation.once("error", reject);
  preparation.once("exit", (code) => resolveCode(code ?? 1));
});
if (preparationCode !== 0) process.exit(preparationCode);

const server = spawn(process.execPath, [builtServer], {
  cwd: process.cwd(),
  windowsHide: true,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    APP_ORIGIN: baseURL,
    SUPABASE_URL: "http://localhost:54321",
    SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-real-credential",
    SESSION_HASH_SECRET: "test-session-hash-secret-0123456789abcdef",
    DEVICE_SIGNING_SECRET: "test-device-signing-secret-0123456789abcdef",
    DEVICE_HASH_SECRET: "test-device-hash-secret-0123456789abcdef",
    RATE_LIMIT_HMAC_SECRET: "test-rate-limit-hmac-secret-0123456789abcdef",
    TRUST_PROXY: "false",
    APP_PROXY_MODE: "none",
    PORT: port,
    HOSTNAME: parsedBase.hostname,
  },
});

function childExit(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code: code ?? 1, signal }));
  });
}

async function stopServer() {
  if (server.exitCode !== null || server.signalCode !== null) return;
  server.kill("SIGTERM");
  const stopped = await Promise.race([childExit(server).then(() => true), delay(5_000, false)]);
  if (!stopped) {
    server.kill("SIGKILL");
    await Promise.race([childExit(server), delay(2_000)]);
  }
}

let testExit = 1;
try {
  const serverExit = childExit(server);
  let ready = false;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      const result = await serverExit;
      throw new Error(`Standalone test server exited before health check (${result.code}).`);
    }
    try {
      const response = await fetch(new URL("/api/health", baseURL), { signal: AbortSignal.timeout(2_000) });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server is still starting; retry until the bounded startup deadline.
    }
    await delay(250);
  }
  if (!ready) throw new Error("Standalone test server did not become healthy within 120 seconds.");

  const playwright = spawn(process.execPath, [resolve("node_modules/@playwright/test/cli.js"), "test"], {
    cwd: process.cwd(),
    windowsHide: true,
    stdio: "inherit",
    env: process.env,
  });
  const result = await childExit(playwright);
  testExit = result.code;
} catch (error) {
  console.error(error instanceof Error ? error.message : "End-to-end test setup failed.");
} finally {
  await stopServer();
}

process.exitCode = testExit;
