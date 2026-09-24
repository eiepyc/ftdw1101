import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const defaultRoot = process.platform === "win32" ? "E:\\CodexData\\caches" : tmpdir();
const root = process.env.PLAYWRIGHT_TEMP_ROOT ?? defaultRoot;
const temp = process.env.PLAYWRIGHT_TEMP_DIR ?? join(root, "playwright-temp");
const output = process.env.PLAYWRIGHT_OUTPUT_DIR ?? join(root, "playwright-test-results");
mkdirSync(temp, { recursive: true });
mkdirSync(output, { recursive: true });
process.env.PLAYWRIGHT_BROWSERS_PATH ??= join(root, "ms-playwright");
process.env.TEMP = temp;
process.env.TMP = temp;
process.env.TMPDIR = temp;

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3400";
const launchOptions = process.env.PLAYWRIGHT_CHANNEL
  ? { channel: process.env.PLAYWRIGHT_CHANNEL }
  : process.platform === "win32" ? { channel: "chrome" } : {};

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: process.env.PLAYWRIGHT_REPORT_DIR ?? join(root, "playwright-report"), open: "never" }]],
  outputDir: resolve(output),
  use: {
    baseURL,
    browserName: "chromium",
    launchOptions,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
