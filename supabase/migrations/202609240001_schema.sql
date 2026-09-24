begin;

create schema if not exists app_private;
revoke all on schema app_private from public, anon, authenticated;
create table if not exists app_private.migration_markers (
  marker text primary key,
  applied_at timestamptz not null default now()
);

create or replace function app_private.is_monday_week_key(p_key text)
returns boolean language plpgsql immutable strict set search_path = '' as $$
declare v_date date;
begin
  if p_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return false; end if;
  v_date := p_key::date;
  return to_char(v_date,'YYYY-MM-DD')=p_key and extract(isodow from v_date)=1;
exception when others then return false;
end;
$$;

do $$
begin
  if to_regclass('public.marks') is not null then
    if exists (select 1 from public.marks m where not app_private.is_monday_week_key(m.week_key)
      or m.nickname is null or length(btrim(m.nickname)) not between 1 and 30
      or m.day_index not between 0 and 6 or m.slot_index not between 0 and 3) then
      raise exception 'migration stopped: marks contains invalid week, nickname, day, or slot data; resolve manually';
    end if;
    if exists (select 1 from public.marks group by user_id,week_key,day_index,slot_index having count(*)>1) then
      raise exception 'migration stopped: duplicate user/week/cell marks exist; resolve manually';
    end if;
  end if;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  username text, auth_email text,
  role text not null default 'user',
  status text not null default 'active',
  deleted_at timestamptz,
  auth_epoch bigint not null default 0,
  password_reset_attempt uuid,
  password_reset_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists auth_email text;
alter table public.profiles add column if not exists role text not null default 'user';
alter table public.profiles add column if not exists status text not null default 'active';
alter table public.profiles add column if not exists deleted_at timestamptz;
alter table public.profiles add column if not exists auth_epoch bigint not null default 0;
alter table public.profiles add column if not exists password_reset_attempt uuid;
alter table public.profiles add column if not exists password_reset_started_at timestamptz;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

create temporary table app_legacy_user_map on commit drop as
select u.id,coalesce(p.auth_email,u.email) as auth_email,
  lower(coalesce(nullif(p.username,''),nullif(u.raw_app_meta_data->>'username',''),
    case when lower(split_part(coalesce(u.email,''),'@',2))='team-slots.local' then split_part(coalesce(u.email,''),'@',1) end)) as username
from auth.users u left join public.profiles p on p.id=u.id;

do $$
begin
  if exists(select 1 from app_legacy_user_map where username is null or username !~ '^[a-z0-9_]{3,24}$' or auth_email is null) then
    raise exception 'migration stopped: an Auth account has no reliable username/email mapping; resolve ownership manually';
  end if;
  if exists(select 1 from app_legacy_user_map group by username having count(*)>1) then
    raise exception 'migration stopped: Auth accounts map to duplicate usernames; resolve conflicts manually';
  end if;
  if exists(select 1 from public.profiles p left join app_legacy_user_map m on m.id=p.id where m.id is null) then
    raise exception 'migration stopped: a profile has no matching Auth account; resolve ownership manually';
  end if;
  if exists(select 1 from public.profiles p join app_legacy_user_map m on m.id=p.id
    where (p.username is not null and lower(p.username)<>m.username)
       or (p.auth_email is not null and lower(p.auth_email)<>lower(m.auth_email))) then
    raise exception 'migration stopped: profile and Auth identity mappings conflict; resolve manually';
  end if;
  if exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.auth_email is not null and lower(p.auth_email)<>lower(coalesce(u.email,''))) then
    raise exception 'migration stopped: saved Auth email mapping no longer matches Auth; resolve ownership manually';
  end if;
  if exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.username is not null and u.raw_app_meta_data->>'username' is not null
      and lower(p.username)<>lower(u.raw_app_meta_data->>'username')) then
    raise exception 'migration stopped: profile and server-managed Auth username mappings conflict';
  end if;
end;
$$;

do $$
begin
  if not exists(select 1 from app_private.migration_markers where marker='legacy_profile_flags') then
    if exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='is_admin') then
      execute 'update public.profiles set role=case when is_admin then ''admin'' else coalesce(role,''user'') end';
    end if;
    if exists(select 1 from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='is_banned') then
      execute 'update public.profiles set status=case when is_banned then ''banned'' else coalesce(status,''active'') end';
    end if;
    insert into app_private.migration_markers(marker) values('legacy_profile_flags') on conflict(marker) do nothing;
  end if;
end;
$$;

insert into public.profiles(id,username,auth_email)
select id,username,auth_email from app_legacy_user_map
on conflict(id) do update set username=coalesce(public.profiles.username,excluded.username),
  auth_email=coalesce(public.profiles.auth_email,excluded.auth_email);
update public.profiles set role='user' where role is null;
update public.profiles set status='active' where status is null;
update public.profiles set created_at=now() where created_at is null;
update public.profiles set updated_at=now() where updated_at is null;
do $$
begin
  if exists(select 1 from public.profiles where username is null or username !~ '^[a-z0-9_]{3,24}$' or auth_email is null) then
    raise exception 'migration stopped: profiles contains invalid username or missing Auth email mapping';
  end if;
  if exists(select 1 from public.profiles group by username having count(*)>1) then raise exception 'migration stopped: duplicate profile usernames'; end if;
  if exists(select 1 from public.profiles where role not in ('user','admin') or status not in ('active','banned','deleted','reset_pending')) then
    raise exception 'migration stopped: profiles contains unsupported role or status';
  end if;
end;
$$;
do $$
declare v_constraint text;
begin
  for v_constraint in select c.conname from pg_constraint c where c.conrelid='public.profiles'::regclass
      and c.contype='f' and c.confrelid='auth.users'::regclass loop
    execute format('alter table public.profiles drop constraint %I',v_constraint);
  end loop;
  alter table public.profiles add constraint profiles_id_fkey foreign key(id) references auth.users(id) on delete restrict;
end;
$$;
alter table public.profiles alter column username set not null;
alter table public.profiles alter column auth_email set not null;
create unique index if not exists profiles_username_lower_uidx on public.profiles(lower(username));
create unique index if not exists profiles_auth_email_lower_uidx on public.profiles(lower(auth_email));
create index if not exists profiles_status_role_idx on public.profiles(status,role,created_at desc);
do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_role_check') then
    alter table public.profiles add constraint profiles_role_check check(role in ('user','admin'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.profiles'::regclass and conname='profiles_status_check') then
    alter table public.profiles add constraint profiles_status_check check(status in ('active','banned','deleted','reset_pending'));
  end if;
end;
$$;

create table if not exists public.device_quotas (
  device_hash text primary key check(device_hash ~ '^[0-9a-f]{64}$'),
  registrations smallint not null default 0 check(registrations between 0 and 2),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete restrict,
  token_hash text not null unique check(token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),expires_at timestamptz not null,revoked_at timestamptz
);
create index if not exists app_sessions_user_idx on public.app_sessions(user_id,expires_at desc);
create index if not exists app_sessions_live_idx on public.app_sessions(expires_at) where revoked_at is null;
create table if not exists public.rate_limits (
  bucket_hash text primary key check(bucket_hash ~ '^[0-9a-f]{64}$'),window_start timestamptz not null,
  hits integer not null check(hits>=0),expires_at timestamptz not null
);
create index if not exists rate_limits_expiry_idx on public.rate_limits(expires_at);
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,actor_user_id uuid references auth.users(id) on delete restrict,
  target_user_id uuid references auth.users(id) on delete restrict,action text not null,reason text not null,
  affected_count integer not null default 0 check(affected_count>=0),created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc,id desc);
create index if not exists audit_log_target_idx on public.audit_log(target_user_id,created_at desc);
create table if not exists public.bootstrap_state (
  id boolean primary key default true check(id),consumed_at timestamptz,created_at timestamptz not null default now()
);
insert into public.bootstrap_state(id) values(true) on conflict(id) do nothing;
update public.bootstrap_state set consumed_at=coalesce(consumed_at,now()) where id=true
  and exists(select 1 from public.profiles where role='admin' and status='active');

create table if not exists public.marks (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete restrict,
  week_key text not null,day_index integer not null check(day_index between 0 and 6),slot_index integer not null check(slot_index between 0 and 3),
  nickname text not null,location text not null default '皆可',created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),deleted_at timestamptz
);
alter table public.marks add column if not exists location text;
alter table public.marks add column if not exists updated_at timestamptz not null default now();
alter table public.marks add column if not exists deleted_at timestamptz;
update public.marks set location='皆可' where location is null or btrim(location)='';
alter table public.marks alter column location set default '皆可';
alter table public.marks alter column location set not null;
do $$
declare v_constraint text;
begin
  for v_constraint in select c.conname from pg_constraint c where c.conrelid='public.marks'::regclass
      and c.contype='f' and c.confrelid='auth.users'::regclass loop
    execute format('alter table public.marks drop constraint %I',v_constraint);
  end loop;
  alter table public.marks add constraint marks_user_id_fkey foreign key(user_id) references auth.users(id) on delete restrict;
end;
$$;
create unique index if not exists marks_user_week_cell_uidx on public.marks(user_id,week_key,day_index,slot_index);
create index if not exists marks_week_cell_active_idx on public.marks(week_key,day_index,slot_index) where deleted_at is null;
create index if not exists marks_user_active_idx on public.marks(user_id,week_key desc) where deleted_at is null;
do $$
begin
  if not exists(select 1 from pg_constraint where conrelid='public.marks'::regclass and conname='marks_week_key_monday_check') then
    alter table public.marks add constraint marks_week_key_monday_check check(app_private.is_monday_week_key(week_key));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.marks'::regclass and conname='marks_nickname_length_check') then
    alter table public.marks add constraint marks_nickname_length_check check(length(btrim(nickname)) between 1 and 30);
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.marks'::regclass and conname='marks_location_length_check') then
    alter table public.marks add constraint marks_location_length_check check(length(btrim(location)) between 1 and 100);
  end if;
end;
$$;

create or replace function app_private.on_auth_user_created()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_username text;v_device_hash text;v_count smallint;
begin
  v_username:=lower(coalesce(new.raw_app_meta_data->>'username',''));
  v_device_hash:=coalesce(new.raw_app_meta_data->>'device_hash','');
  if v_username !~ '^[a-z0-9_]{3,24}$' or v_device_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'registration must be created through the application service' using errcode='42501';
  end if;
  if lower(coalesce(new.email,'')) <> v_username || '@team-slots.local' then raise exception 'registration identity mapping is invalid' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_device_hash,0));
  insert into public.device_quotas(device_hash,registrations) values(v_device_hash,0) on conflict(device_hash) do nothing;
  select registrations into v_count from public.device_quotas where device_hash=v_device_hash for update;
  if v_count>=2 then raise exception 'device account quota reached' using errcode='23514'; end if;
  insert into public.profiles(id,username,auth_email,role,status) values(new.id,v_username,new.email,'user','active');
  update public.device_quotas set registrations=v_count+1,updated_at=now() where device_hash=v_device_hash;
  return new;
end;
$$;
drop trigger if exists app_auth_user_created on auth.users;
create trigger app_auth_user_created after insert on auth.users for each row execute function app_private.on_auth_user_created();

alter table public.profiles enable row level security;
alter table public.device_quotas enable row level security;
alter table public.app_sessions enable row level security;
alter table public.rate_limits enable row level security;
alter table public.audit_log enable row level security;
alter table public.bootstrap_state enable row level security;
alter table public.marks enable row level security;
revoke all on table public.profiles,public.device_quotas,public.app_sessions,public.rate_limits,public.audit_log,public.bootstrap_state,public.marks from public,anon,authenticated;
grant select,insert,update,delete on table public.profiles,public.device_quotas,public.app_sessions,public.rate_limits,public.audit_log,public.bootstrap_state,public.marks to service_role;
grant usage,select on sequence public.audit_log_id_seq to service_role;
revoke all on function app_private.is_monday_week_key(text) from public,anon,authenticated;
revoke all on function app_private.on_auth_user_created() from public,anon,authenticated;

commit;
