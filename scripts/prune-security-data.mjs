import { callSupabaseRpc } from "./supabase-rpc.mjs";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Security-data cleanup requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(2);
}

try {
  const data = await callSupabaseRpc("app_prune_security_data", {});
  if (!data || !Number.isInteger(data.sessions) || !Number.isInteger(data.rate_limits)) {
    console.error("Security-data cleanup failed.");
    process.exit(1);
  }
  console.log(`Pruned ${data.sessions} expired/revoked sessions and ${data.rate_limits} expired rate-limit buckets.`);
} catch {
  console.error("Security-data cleanup failed; no credential or upstream response was recorded.");
  process.exit(1);
}
