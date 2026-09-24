import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProxyMode, trustedClientIp } from "../lib/server/client-ip";

test("proxy mode is explicit when configured and preserves the legacy Caddy switch", () => {
  assert.equal(parseProxyMode(undefined, false), "none");
  assert.equal(parseProxyMode(undefined, true), "caddy");
  assert.equal(parseProxyMode("edgeone", true), "edgeone");
  assert.equal(parseProxyMode("vercel", true), "vercel");
  assert.equal(parseProxyMode(" none ", true), "none");
  assert.throws(() => parseProxyMode("forwarded", false), /APP_PROXY_MODE/);
});

test("none mode ignores every forwarded address", () => {
  const headers = new Headers({
    "eo-connecting-ip": "198.51.100.21",
    "x-real-ip": "203.0.113.22",
    "x-forwarded-for": "192.0.2.23",
    "x-vercel-forwarded-for": "203.0.113.24",
  });
  assert.equal(trustedClientIp(headers, "none"), "shared");
});

test("Caddy mode trusts only a single valid X-Real-IP", () => {
  assert.equal(trustedClientIp(new Headers({ "x-real-ip": "203.0.113.8", "eo-connecting-ip": "198.51.100.2" }), "caddy"), "203.0.113.8");
  assert.equal(trustedClientIp(new Headers({ "eo-connecting-ip": "198.51.100.2", "x-forwarded-for": "192.0.2.3" }), "caddy"), "shared");
  assert.equal(trustedClientIp(new Headers({ "x-real-ip": "203.0.113.8, 192.0.2.3" }), "caddy"), "shared");
});

test("EdgeOne mode accepts one valid IPv4 or IPv6 address and ignores other headers", () => {
  assert.equal(trustedClientIp(new Headers({ "eo-connecting-ip": "203.0.113.9" }), "edgeone"), "203.0.113.9");
  assert.equal(trustedClientIp(new Headers({ "eo-connecting-ip": "2001:db8::9" }), "edgeone"), "2001:db8::9");
  assert.equal(trustedClientIp(new Headers({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "192.0.2.11" }), "edgeone"), "shared");
});

test("EdgeOne mode fails closed to the shared bucket for missing, invalid, or list-valued headers", () => {
  assert.equal(trustedClientIp(new Headers(), "edgeone"), "shared");
  assert.equal(trustedClientIp(new Headers({ "eo-connecting-ip": "not-an-ip" }), "edgeone"), "shared");
  assert.equal(trustedClientIp(new Headers({ "eo-connecting-ip": "203.0.113.1, 198.51.100.2" }), "edgeone"), "shared");
});

test("Vercel mode accepts one valid IPv4 or IPv6 address from its platform header", () => {
  assert.equal(trustedClientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.19" }), "vercel"), "203.0.113.19");
  assert.equal(trustedClientIp(new Headers({ "x-vercel-forwarded-for": "2001:db8::19" }), "vercel"), "2001:db8::19");
});

test("Vercel mode fails closed for missing, invalid, or list-valued addresses and ignores other headers", () => {
  assert.equal(trustedClientIp(new Headers(), "vercel"), "shared");
  assert.equal(trustedClientIp(new Headers({ "x-vercel-forwarded-for": "not-an-ip" }), "vercel"), "shared");
  assert.equal(trustedClientIp(new Headers({ "x-vercel-forwarded-for": "203.0.113.1, 198.51.100.2" }), "vercel"), "shared");
  assert.equal(trustedClientIp(new Headers({
    "x-forwarded-for": "203.0.113.2",
    "x-real-ip": "203.0.113.3",
    "eo-connecting-ip": "203.0.113.4",
  }), "vercel"), "shared");
});
