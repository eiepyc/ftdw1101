import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fromDatabaseError } from "./errors";
import { getServerEnv } from "./env";

type RpcName =
  | "app_auth_identity"
  | "app_device_registrations"
  | "app_register_session"
  | "app_get_session"
  | "app_revoke_session"
  | "app_consume_rate_limit"
  | "app_list_week"
  | "app_list_cell"
  | "app_upsert_marks"
  | "app_delete_mark"
  | "app_admin_list_users"
  | "app_admin_list_audit"
  | "app_admin_action"
  | "app_admin_finish_password_reset"
  | "app_admin_fail_password_reset"
  | "app_admin_marks_action"
  | "app_admin_list_deleted_marks"
  | "app_admin_week_active_count"
  | "app_admin_list_active_marks"
  | "app_bootstrap_first_admin";

let serviceClient: SupabaseClient | undefined;

function noPersistOptions() {
  return { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
}

function boundedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(15_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal, redirect: "error" });
}

export function getServiceClient(): SupabaseClient {
  if (!serviceClient) {
    const env = getServerEnv();
    serviceClient = createClient(env.supabaseUrl, env.serviceRoleKey, {
      ...noPersistOptions(),
      global: { fetch: boundedFetch },
    });
  }
  return serviceClient;
}

export function createRequestAuthClient(): SupabaseClient {
  const env = getServerEnv();
  return createClient(env.supabaseUrl, env.serviceRoleKey, {
    ...noPersistOptions(),
    global: {
      fetch: boundedFetch,
    },
  });
}

export async function rpc<T>(name: RpcName, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getServiceClient().rpc(name, args as never);
  if (error) throw fromDatabaseError(error.code, error.message);
  if (data === null) {
    throw fromDatabaseError(undefined, "empty rpc response");
  }
  return data as T;
}

export type { RpcName };
