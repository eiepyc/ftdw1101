import { callSupabaseRpc } from "./supabase-rpc.mjs";

const [username] = process.argv.slice(2);
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!username || !/^[a-z0-9_]{3,24}$/i.test(username) || !url || !serviceKey) {
  console.error("Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/bootstrap-admin.mjs <existing-username>");
  process.exit(2);
}

try {
  const data = await callSupabaseRpc("app_bootstrap_first_admin", { p_username: username.toLowerCase() });
  console.log(`Initial administrator enabled for ${username.toLowerCase()} (${data}).`);
} catch (error) {
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  console.error(timedOut
    ? "Bootstrap result is unknown because the request timed out. Inspect the database before retrying."
    : "Bootstrap failed. Check the operator configuration and database audit state before retrying.");
  process.exit(1);
}
