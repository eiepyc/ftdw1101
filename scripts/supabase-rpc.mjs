export async function callSupabaseRpc(name, args) {
  const urlValue = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!urlValue || !serviceKey) throw new Error("Supabase service configuration is required.");
  const base = new URL(urlValue);
  if (base.protocol !== "https:" && base.hostname !== "localhost") {
    throw new Error("Supabase URL must use HTTPS outside localhost.");
  }
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(name)) throw new Error("Invalid RPC name.");

  const response = await fetch(new URL(`/rest/v1/rpc/${name}`, base), {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Supabase RPC rejected the request (HTTP ${response.status}).`);
  return response.json();
}
