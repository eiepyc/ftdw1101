import "server-only";
import { parseProxyMode, type ProxyMode } from "./client-ip";

export type ServerEnv = {
  appOrigin: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  sessionHashSecret: string;
  deviceSigningSecret: string;
  deviceHashSecret: string;
  rateLimitHmacSecret: string;
  proxyMode: ProxyMode;
};

let cached: ServerEnv | undefined;

function required(name: string, minimum = 1): string {
  const value = process.env[name]?.trim();
  if (!value || value.length < minimum || /^(replace-with-|change-me|<)/i.test(value)) {
    throw new Error("Server configuration is missing or invalid: " + name);
  }
  return value;
}

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const appOrigin = required("APP_ORIGIN");
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(appOrigin);
  } catch {
    throw new Error("APP_ORIGIN must be an absolute origin");
  }
  if (parsedOrigin.origin !== appOrigin.replace(/\/$/, "") || parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port");
  }
  const supabaseUrl = required("SUPABASE_URL");
  const parsedSupabase = new URL(supabaseUrl);
  if (parsedSupabase.protocol !== "https:" && parsedSupabase.hostname !== "localhost") {
    throw new Error("SUPABASE_URL must use HTTPS outside localhost");
  }
  cached = {
    appOrigin: parsedOrigin.origin,
    supabaseUrl: parsedSupabase.origin,
    serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY", 30),
    sessionHashSecret: required("SESSION_HASH_SECRET", 32),
    deviceSigningSecret: required("DEVICE_SIGNING_SECRET", 32),
    deviceHashSecret: required("DEVICE_HASH_SECRET", 32),
    rateLimitHmacSecret: required("RATE_LIMIT_HMAC_SECRET", 32),
    proxyMode: parseProxyMode(process.env.APP_PROXY_MODE, process.env.TRUST_PROXY === "true"),
  };
  return cached;
}
