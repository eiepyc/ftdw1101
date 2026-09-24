import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getCurrentWeekKey, shiftWeekKey } from "../lib/week";

const migrationFiles = [
  "supabase/migrations/202609240001_schema.sql",
  "supabase/migrations/202609240002_auth_and_marks.sql",
  "supabase/migrations/202609240003_admin.sql",
  "supabase/migrations/202609240004_privileges.sql",
] as const;

const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  member: "00000000-0000-4000-8000-000000000002",
};

let db: PGlite;
const currentWeek = getCurrentWeekKey();

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function applyMigrations(target: PGlite): Promise<void> {
  for (const path of migrationFiles) {
    await target.exec(await readFile(path, "utf8"));
  }
}

async function addAuthUser(target: PGlite, input: { id: string; username: string; deviceHash: string; appMetadata?: boolean }): Promise<void> {
  const appMetadata = input.appMetadata === false ? {} : { username: input.username, device_hash: input.deviceHash };
  await target.query(
    "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3::jsonb,$4::jsonb)",
    [input.id, input.username + "@team-slots.local", JSON.stringify({ username: "forged-client-name" }), JSON.stringify(appMetadata)],
  );
}

async function resetDatabase(legacy = false): Promise<PGlite> {
  const target = new PGlite();
  await target.exec(
    "create role anon; create role authenticated; create role service_role; create schema auth;" +
    "create table auth.users (id uuid primary key,email text unique,raw_user_meta_data jsonb not null default '{}'::jsonb," +
    "raw_app_meta_data jsonb not null default '{}'::jsonb,created_at timestamptz not null default now());",
  );
  if (legacy) {
    await target.query(
      "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values" +
      "($1,$2,$3::jsonb,'{}'::jsonb),($4,$5,$6::jsonb,'{}'::jsonb)",
      [ids.admin, "admin@team-slots.local", JSON.stringify({ username: "attacker-admin" }), ids.member, "member@team-slots.local", JSON.stringify({ username: "attacker-member" })],
    );
    await target.exec(
      "create table public.profiles (id uuid primary key references auth.users(id) on delete cascade,username text," +
      "is_admin boolean not null default false,is_banned boolean not null default false);" +
      "create table public.marks (id uuid primary key default gen_random_uuid()," +
      "user_id uuid not null references auth.users(id) on delete cascade,week_key text not null,day_index integer not null," +
      "slot_index integer not null,nickname text not null,location text not null,created_at timestamptz not null default now());",
    );
    await target.query(
      "insert into public.profiles(id,username,is_admin,is_banned) values($1,'admin',true,false),($2,'member',false,true)",
      [ids.admin, ids.member],
    );
    await target.query(
      "insert into public.marks(user_id,week_key,day_index,slot_index,nickname,location) values($1,$2,0,0,'Admin','   ')",
      [ids.admin, currentWeek],
    );
  }
  return target;
}

before(async () => {
  db = await resetDatabase(true);
  await applyMigrations(db);
});

after(async () => {
  await db.close();
});

test("migrations preserve legacy identity/roles, normalize empty locations, and expose no public data/RPC access", async () => {
  const profiles = await query<{ username: string; auth_email: string; role: string; status: string; auth_epoch: number }>(
    "select username,auth_email,role,status,auth_epoch from public.profiles order by username",
  );
  assert.deepEqual(profiles.map((row) => [row.username, row.auth_email, row.role, row.status, row.auth_epoch]), [
    ["admin", "admin@team-slots.local", "admin", "active", 0],
    ["member", "member@team-slots.local", "user", "banned", 0],
  ]);
  const mark = (await query<{ location: string; on_delete: string }>(
    "select m.location,c.confdeltype::text as on_delete from public.marks m join pg_constraint c " +
    "on c.conrelid='public.marks'::regclass where c.conname='marks_user_id_fkey'",
  ))[0];
  assert.equal(mark.location, "皆可");
  assert.equal(mark.on_delete, "r", "Auth identity deletion is restricted, not cascaded");

  const access = (await query<{ table_read: boolean; rpc_execute: boolean; service_execute: boolean }>(
    "select has_table_privilege('anon','public.marks','select') table_read," +
    "has_function_privilege('anon','public.app_register_session(uuid,text,bigint)','execute') rpc_execute," +
    "has_function_privilege('service_role','public.app_register_session(uuid,text,bigint)','execute') service_execute",
  ))[0];
  assert.equal(access.table_read, false);
  assert.equal(access.rpc_execute, false);
  assert.equal(access.service_execute, true);

  for (const role of ["anon", "authenticated"] as const) {
    for (const sql of [
      "select * from public.marks",
      "select * from public.profiles",
      "select public.app_list_week('" + "a".repeat(64) + "','" + currentWeek + "')",
      "select public.app_prune_security_data()",
    ]) {
      await db.exec("begin");
      try {
        await db.exec("set local role " + role);
        await assert.rejects(db.query(sql), /permission denied/i, `${role} must not access business tables or RPCs`);
      } finally {
        await db.exec("rollback");
      }
    }
  }

  await db.query("update public.profiles set role='user',status='active' where id=$1", [ids.admin]);
  await db.query("update public.profiles set status='active' where id=$1", [ids.member]);
  await db.exec(await readFile(migrationFiles[0], "utf8"));
  const afterRerun = await query<{ username: string; role: string; status: string }>(
    "select username,role,status from public.profiles order by username",
  );
  assert.deepEqual(afterRerun, [
    { username: "admin", role: "user", status: "active" },
    { username: "member", role: "user", status: "active" },
  ], "rerunning the schema migration must not replay legacy is_admin/is_banned flags");
  await db.query("update public.profiles set role='admin' where id=$1", [ids.admin]);
});

test("Auth trigger rejects direct signup and enforces the two-account device quota", async () => {
  const deniedId = "00000000-0000-4000-8000-000000000003";
  await assert.rejects(
    db.query(
      "insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data) values($1,$2,$3::jsonb,$4::jsonb)",
      [deniedId, "direct@team-slots.local", JSON.stringify({ username: "direct", device_hash: "f".repeat(64) }), "{}"],
    ),
    /registration must be created through the application service/,
  );
  assert.equal((await query<{ n: number }>("select count(*)::int n from auth.users where id=$1", [deniedId]))[0].n, 0);

  const deviceHash = "a".repeat(64);
  const outcomes = await Promise.allSettled([
    addAuthUser(db, { id: "00000000-0000-4000-8000-000000000004", username: "deviceone", deviceHash }),
    addAuthUser(db, { id: "00000000-0000-4000-8000-000000000005", username: "devicetwo", deviceHash }),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
  const quota = (await query<{ registrations: number }>("select registrations from public.device_quotas where device_hash=$1", [deviceHash]))[0];
  assert.equal(quota.registrations, 2);
  await assert.rejects(
    addAuthUser(db, { id: "00000000-0000-4000-8000-000000000006", username: "devicethree", deviceHash }),
    /device account quota reached/,
  );
  assert.equal((await query<{ n: number }>("select count(*)::int n from auth.users where id='00000000-0000-4000-8000-000000000006'"))[0].n, 0);
  assert.equal((await query<{ n: number }>("select count(*)::int n from public.profiles where username in ('deviceone','devicetwo','devicethree')"))[0].n, 2);

  const rates = await query<{ allowed: boolean }>("select allowed from public.app_consume_rate_limit($1,1,300)", ["b".repeat(64)]);
  const secondRate = await query<{ allowed: boolean }>("select allowed from public.app_consume_rate_limit($1,1,300)", ["b".repeat(64)]);
  assert.equal(rates[0].allowed, true);
  assert.equal(secondRate[0].allowed, false);
});

test("session epochs, mark ownership/window, soft deletion/recovery, and admin audit hold", async () => {
  const adminSession = "c".repeat(64);
  await db.query("select public.app_register_session($1,$2,$3)", [ids.admin, adminSession, 0]);

  await db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "unban", "return to service"]);
  const identity = (await query<{ user_id: string; auth_email: string; auth_epoch: number }>("select * from public.app_auth_identity('member')"))[0];
  assert.equal(identity.auth_email, "member@team-slots.local");
  const memberSession = "d".repeat(64);
  await db.query("select public.app_register_session($1,$2,$3)", [ids.member, memberSession, identity.auth_epoch]);
  await assert.rejects(db.query("select public.app_admin_list_users($1)", [memberSession]), /forbidden/i, "an ordinary member cannot use admin RPCs");

  const items = [
    { day_index: 0, slot_index: 0, nickname: "Member", location: "", user_id: ids.admin },
    { day_index: 0, slot_index: 1, nickname: "Member", location: "   ", user_id: ids.admin },
  ];
  const firstWrite = (await query<{ app_upsert_marks: { accepted: number; changed: number } }>(
    "select public.app_upsert_marks($1,$2,$3::jsonb)", [memberSession, currentWeek, JSON.stringify(items)],
  ))[0].app_upsert_marks;
  const retryWrite = (await query<{ app_upsert_marks: { accepted: number; changed: number } }>(
    "select public.app_upsert_marks($1,$2,$3::jsonb)", [memberSession, currentWeek, JSON.stringify(items)],
  ))[0].app_upsert_marks;
  assert.equal(firstWrite.accepted, 2);
  assert.equal(firstWrite.changed, 2);
  assert.equal(retryWrite.changed, 0);
  const owned = await query<{ id: string; user_id: string; location: string }>(
    "select id,user_id,location from public.marks where user_id=$1 and week_key=$2 order by slot_index", [ids.member, currentWeek],
  );
  assert.equal(owned.length, 2);
  assert.ok(owned.every((row) => row.user_id === ids.member), "client-supplied user_id is ignored");
  assert.ok(owned.every((row) => row.location === "皆可"));

  const countBeforeInvalidBatch = (await query<{ n: number }>("select count(*)::int n from public.marks where user_id=$1 and week_key=$2", [ids.member, currentWeek]))[0].n;
  const invalidMixedBatch = [
    { day_index: 2, slot_index: 0, nickname: "Valid", location: "Room" },
    { day_index: 2, slot_index: 9, nickname: "Invalid", location: "Room" },
  ];
  await assert.rejects(
    db.query("select public.app_upsert_marks($1,$2,$3::jsonb)", [memberSession, currentWeek, JSON.stringify(invalidMixedBatch)]),
    /invalid mark item/i,
  );
  assert.equal((await query<{ n: number }>("select count(*)::int n from public.marks where user_id=$1 and week_key=$2", [ids.member, currentWeek]))[0].n, countBeforeInvalidBatch, "a rejected batch must leave no valid item behind");
  await assert.rejects(
    db.query("select public.app_upsert_marks($1,$2,$3::jsonb)", [memberSession, shiftWeekKey(currentWeek, 5), JSON.stringify([{ day_index: 0, slot_index: 0, nickname: "Future", location: "" }])]),
    /week is outside the allowed window/i,
  );
  const otherUsersMark = (await query<{ id: string }>(
    "select id from public.marks where user_id=$1 and week_key=$2 and deleted_at is null", [ids.admin, currentWeek],
  ))[0];
  await assert.rejects(db.query("select public.app_delete_mark($1,$2)", [memberSession, otherUsersMark.id]), /forbidden/);
  await db.query("select public.app_delete_mark($1,$2)", [memberSession, owned[0].id]);

  const oldWeekDate = new Date(currentWeek + "T00:00:00Z");
  oldWeekDate.setUTCDate(oldWeekDate.getUTCDate() - 7);
  const oldWeek = oldWeekDate.getUTCFullYear() + "-" + String(oldWeekDate.getUTCMonth() + 1).padStart(2, "0") + "-" + String(oldWeekDate.getUTCDate()).padStart(2, "0");
  await db.query("insert into public.marks(user_id,week_key,day_index,slot_index,nickname,location) values($1,$2,0,2,'Old','皆可')", [ids.member, oldWeek]);
  const oldMark = (await query<{ id: string }>("select id from public.marks where week_key=$1 and user_id=$2", [oldWeek, ids.member]))[0];
  await assert.rejects(db.query("select public.app_delete_mark($1,$2)", [memberSession, oldMark.id]), /outside the allowed window/);

  await db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "delete", "account cleanup"]);
  assert.equal((await query<{ n: number }>("select count(*)::int n from public.app_get_session($1)", [memberSession]))[0].n, 0);
  const visibleWhileDeleted = await query<{ total: string }>(
    "select count(*)::text total from public.marks m join public.profiles p on p.id=m.user_id and p.status='active' " +
    "where m.week_key=$1 and m.deleted_at is null and m.user_id=$2", [currentWeek, ids.member],
  );
  assert.equal(visibleWhileDeleted[0].total, "0");

  await db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "restore", "restore account"]);
  const remainingActive = (await query<{ n: number }>(
    "select count(*)::int n from public.marks where user_id=$1 and week_key=$2 and deleted_at is null", [ids.member, currentWeek],
  ))[0].n;
  assert.equal(remainingActive, 1, "account restore must not restore its independently deleted mark");
  const deleted = await query<{ id: string }>(
    "select id from public.marks where user_id=$1 and week_key=$2 and deleted_at is not null", [ids.member, currentWeek],
  );
  const restored = (await query<{ app_admin_marks_action: number }>(
    "select public.app_admin_marks_action($1,'restore_marks',$2,array[$3]::uuid[],'restore selected')",
    [adminSession, currentWeek, deleted[0].id],
  ))[0].app_admin_marks_action;
  assert.equal(restored, 1);
  const cleared = (await query<{ app_admin_marks_action: number }>(
    "select public.app_admin_marks_action($1,'clear_week',$2,null,'weekly cleanup')", [adminSession, currentWeek],
  ))[0].app_admin_marks_action;
  assert.equal(cleared, 3, "bulk operation returns actual changed row count");

  await assert.rejects(
    db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.admin, "delete", "try remove self"]),
    /last active administrator/,
  );

  const beforeReset = (await query<{ auth_epoch: number }>("select * from public.app_auth_identity('member')"))[0].auth_epoch;
  const preResetSession = "2".repeat(64);
  await db.query("select public.app_register_session($1,$2,$3)", [ids.member, preResetSession, beforeReset]);
  const firstReset = (await query<{ app_admin_action: { reset_attempt: string; affected_count: number } }>(
    "select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "prepare_password_reset", "replace password"],
  ))[0].app_admin_action;
  assert.equal(firstReset.affected_count, 1);
  const overlappingReset = (await query<{ app_admin_action: { reset_attempt: string | null; affected_count: number } }>(
    "select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "prepare_password_reset", "overlapping reset"],
  ))[0].app_admin_action;
  assert.equal(overlappingReset.affected_count, 0);
  assert.equal(overlappingReset.reset_attempt, null);
  await db.query("select public.app_admin_fail_password_reset($1,$2,$3)", [adminSession, ids.member, firstReset.reset_attempt]);
  const retryReset = (await query<{ app_admin_action: { reset_attempt: string; affected_count: number } }>(
    "select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "prepare_password_reset", "retry after failure"],
  ))[0].app_admin_action;
  assert.equal(retryReset.affected_count, 1);
  await assert.rejects(
    db.query("select public.app_register_session($1,$2,$3)", [ids.member, "e".repeat(64), beforeReset]),
    /account unavailable/,
  );
  await assert.rejects(db.query("select public.app_list_week($1,$2)", [preResetSession, currentWeek]), /unauthenticated/i, "a previous session cannot read data during reset pending");
  await assert.rejects(
    db.query("select public.app_admin_finish_password_reset($1,$2,$3,$4)", [adminSession, ids.member, firstReset.reset_attempt, "stale reset completion"]),
    /password reset is not pending/,
  );
  await db.query("select public.app_admin_finish_password_reset($1,$2,$3,$4)", [adminSession, ids.member, retryReset.reset_attempt, "password changed"]);
  await assert.rejects(
    db.query("select public.app_register_session($1,$2,$3)", [ids.member, "f".repeat(64), beforeReset]),
    /account unavailable/,
  );
  const finalEpoch = (await query<{ auth_epoch: number }>("select * from public.app_auth_identity('member')"))[0].auth_epoch;
  const restoredSession = "1".repeat(64);
  await db.query("select public.app_register_session($1,$2,$3)", [ids.member, restoredSession, finalEpoch]);
  await db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "ban", "security regression test"]);
  await assert.rejects(db.query("select public.app_list_week($1,$2)", [restoredSession, currentWeek]), /unauthenticated/i, "a previous session cannot read data after a ban");
  await db.query("select public.app_admin_action($1,$2,$3,$4)", [adminSession, ids.member, "unban", "security regression test complete"]);
  const audit = (await query<{ count: number }>("select count(*)::int count from public.audit_log where target_user_id=$1", [ids.member]))[0];
  assert.ok(audit.count >= 5);
});

test("SQL keyset pages preserve adjacent PostgreSQL microseconds", async () => {
  const fresh = await resetDatabase(false);
  try {
    await applyMigrations(fresh);
    await fresh.exec("set time zone 'UTC'");
    const firstId = "00000000-0000-4000-8000-000000000011";
    const secondId = "00000000-0000-4000-8000-000000000012";
    const thirdId = "00000000-0000-4000-8000-000000000013";
    const users = [ids.admin, ids.member, "00000000-0000-4000-8000-000000000014"];
    for (const [index, id] of users.entries()) {
      await addAuthUser(fresh, { id, username: "micropage" + index, deviceHash: String(index + 1).repeat(64) });
    }
    const sessionHash = "b".repeat(64);
    await fresh.query("select public.app_register_session($1,$2,$3)", [ids.member, sessionHash, 0]);
    await fresh.query(
      "insert into public.marks(id,user_id,week_key,day_index,slot_index,nickname,location,created_at) values" +
      "($1,$4,$5,6,3,'one','皆可','2026-09-24T00:00:00.123457Z')," +
      "($2,$6,$5,6,3,'two','皆可','2026-09-24T00:00:00.123456Z')," +
      "($3,$7,$5,6,3,'three','皆可','2026-09-24T00:00:00.123455Z')",
      [firstId, secondId, thirdId, ids.admin, currentWeek, ids.member, users[2]],
    );
    const first = (await fresh.query<{ page: { items: Array<{ id: string; created_at: string }>; hasMore: boolean } }>(
      "select public.app_list_cell($1,$2,6,3,null,null,1) page", [sessionHash, currentWeek],
    )).rows[0].page;
    assert.equal(first.items[0].id, firstId);
    assert.equal(first.items[0].created_at, "2026-09-24T00:00:00.123457+00:00");
    assert.equal(first.hasMore, true);
    const second = (await fresh.query<{ page: { items: Array<{ id: string; created_at: string }>; hasMore: boolean } }>(
      "select public.app_list_cell($1,$2,6,3,$3,$4,1) page", [sessionHash, currentWeek, first.items[0].created_at, first.items[0].id],
    )).rows[0].page;
    assert.equal(second.items[0].id, secondId, "the page cursor retains microseconds rather than flooring to milliseconds");
    assert.equal(second.items[0].created_at, "2026-09-24T00:00:00.123456+00:00");
  } finally {
    await fresh.close();
  }
});

test("scheduled cleanup prunes expired sessions and rate limit buckets only", async () => {
  const fresh = await resetDatabase(false);
  try {
    await applyMigrations(fresh);
    await addAuthUser(fresh, { id: "00000000-0000-4000-8000-000000000021", username: "cleanup_user", deviceHash: "e".repeat(64) });
    await fresh.query(
      "insert into public.app_sessions(user_id,token_hash,expires_at,revoked_at) values" +
      "($1,$2,now()-interval '2 days',null),($1,$3,now()+interval '1 day',now()-interval '8 days')," +
      "($1,$4,now()+interval '1 day',null)",
      ["00000000-0000-4000-8000-000000000021", "a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    await fresh.query("insert into public.rate_limits(bucket_hash,window_start,hits,expires_at) values($1,now()-interval '2 days',1,now()-interval '1 day'),($2,now(),1,now()+interval '1 day')", ["d".repeat(64), "f".repeat(64)]);
    const result = (await fresh.query<{ app_prune_security_data: { sessions: number; rate_limits: number } }>("select public.app_prune_security_data()")).rows[0].app_prune_security_data;
    assert.deepEqual(result, { sessions: 2, rate_limits: 1 });
    assert.equal((await fresh.query<{ n: number }>("select count(*)::int n from public.app_sessions")).rows[0].n, 1);
    assert.equal((await fresh.query<{ n: number }>("select count(*)::int n from public.rate_limits")).rows[0].n, 1);
  } finally {
    await fresh.close();
  }
});

test("one-time bootstrap promotes only an existing account and cannot be repeated", async () => {
  const fresh = await resetDatabase(false);
  try {
    await applyMigrations(fresh);
    await addAuthUser(fresh, {
      id: "00000000-0000-4000-8000-000000000009",
      username: "operator",
      deviceHash: "9".repeat(64),
    });
    const before = (await fresh.query<{ role: string }>("select role from public.profiles where username='operator'")).rows[0];
    assert.equal(before.role, "user");
    await fresh.query("select public.app_bootstrap_first_admin('operator')");
    const afterBootstrap = (await fresh.query<{ role: string }>("select role from public.profiles where username='operator'")).rows[0];
    assert.equal(afterBootstrap.role, "admin");
    await assert.rejects(fresh.query("select public.app_bootstrap_first_admin('operator')"), /already been used/);
    const publicAccess = (await fresh.query<{ allowed: boolean }>(
      "select has_function_privilege('authenticated','public.app_bootstrap_first_admin(text)','execute') allowed",
    )).rows[0];
    assert.equal(publicAccess.allowed, false);
  } finally {
    await fresh.close();
  }
});
