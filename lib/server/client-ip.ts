import { isIP } from "node:net";

export type ProxyMode = "none" | "caddy" | "edgeone" | "vercel";

export function parseProxyMode(explicit: string | undefined, legacyTrustProxy: boolean): ProxyMode {
  if (explicit === undefined) return legacyTrustProxy ? "caddy" : "none";
  const mode = explicit.trim().toLowerCase();
  if (mode === "none" || mode === "caddy" || mode === "edgeone" || mode === "vercel") return mode;
  throw new Error("APP_PROXY_MODE must be none, caddy, edgeone, or vercel");
}

export function trustedClientIp(headers: Headers, mode: ProxyMode): string {
  const headerName = mode === "edgeone"
    ? "eo-connecting-ip"
    : mode === "caddy"
      ? "x-real-ip"
      : mode === "vercel"
        ? "x-vercel-forwarded-for"
        : undefined;
  if (!headerName) return "shared";
  const candidate = headers.get(headerName)?.trim() ?? "";
  if (!candidate || candidate.includes(",")) return "shared";
  return isIP(candidate) ? candidate : "shared";
}
