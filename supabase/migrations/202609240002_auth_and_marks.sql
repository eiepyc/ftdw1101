begin;

create or replace function app_private.assert_week_window(p_week_key text,p_min_weeks integer,p_max_weeks integer)
returns date language plpgsql stable set search_path = '' as $$
declare v_week date;v_today date;v_monday date;
begin
  if not app_private.is_monday_week_key(p_week_key) then raise exception 'invalid week key' using errcode='22023'; end if;
  v_week:=p_week_key::date;
  v_today:=(now() at time zone 'Asia/Shanghai')::date;
  v_monday:=v_today-(extract(isodow from v_today)::integer-1);
  if v_week<v_monday+p_min_weeks*7 or v_week>v_monday+p_max_weeks*7 then
    raise exception 'week is outside the allowed window' using errcode='22023';
  end if;
  return v_week;
end;
$$;

create or replace function app_private.assert_actor(p_session_hash text,p_admin boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid;v_role text;
begin
  if p_session_hash is null or p_session_hash !~ '^[0-9a-f]{64}$' then raise exception 'unauthenticated' using errcode='28000'; end if;
  select s.user_id,p.role into v_user,v_role
  from public.app_sessions s join public.profiles p on p.id=s.user_id
  where s.token_hash=p_session_hash and s.revoked_at is null and s.expires_at>now() and p.status='active'
  for share of p;
  if v_user is null then raise exception 'unauthenticated' using errcode='28000'; end if;
  if p_admin and v_role<>'admin' then raise exception 'forbidden' using errcode='42501'; end if;
  return v_user;
end;
$$;

create or replace function public.app_auth_identity(p_username text)
returns table(user_id uuid,auth_email text,auth_epoch bigint)
language sql security definer set search_path = '' as $$
  select p.id,p.auth_email,p.auth_epoch from public.profiles p where p.username=lower(p_username)
$$;

create or replace function public.app_device_registrations(p_device_hash text)
returns smallint language sql security definer set search_path = '' as $$
  select coalesce((select d.registrations from public.device_quotas d where d.device_hash=p_device_hash),0)::smallint
$$;

create or replace function public.app_register_session(p_user_id uuid,p_token_hash text,p_expected_auth_epoch bigint)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare v_expiry timestamptz;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid token hash' using errcode='22023'; end if;
  if p_expected_auth_epoch is null then raise exception 'missing authentication epoch' using errcode='22023'; end if;
  perform 1 from public.profiles p where p.id=p_user_id and p.status='active'
    and p.auth_epoch=p_expected_auth_epoch for share;
  if not found then raise exception 'account unavailable' using errcode='28000'; end if;
  v_expiry:=now()+interval '12 hours';
  insert into public.app_sessions(user_id,token_hash,expires_at) values(p_user_id,p_token_hash,v_expiry);
  return v_expiry;
end;
$$;

create or replace function public.app_get_session(p_token_hash text)
returns table(user_id uuid,username text,is_admin boolean,expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
begin
  return query select p.id,p.username,p.role='admin',s.expires_at
  from public.app_sessions s join public.profiles p on p.id=s.user_id
  where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>now() and p.status='active';
end;
$$;

create or replace function public.app_revoke_session(p_token_hash text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.app_sessions set revoked_at=coalesce(revoked_at,now()) where token_hash=p_token_hash and revoked_at is null;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

create or replace function public.app_consume_rate_limit(p_bucket_hash text,p_limit integer,p_window_seconds integer)
returns table(allowed boolean,retry_after integer)
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz:=clock_timestamp();v_start timestamptz;v_hits integer;v_retry integer;
begin
  if p_bucket_hash is null or p_bucket_hash !~ '^[0-9a-f]{64}$' or p_limit<1 or p_window_seconds<1 or p_window_seconds>86400 then
    raise exception 'invalid rate limit request' using errcode='22023';
  end if;
  v_start:=to_timestamp(floor(extract(epoch from v_now)/p_window_seconds)*p_window_seconds);
  insert into public.rate_limits(bucket_hash,window_start,hits,expires_at)
  values(p_bucket_hash,v_start,1,v_start+make_interval(secs=>p_window_seconds*2))
  on conflict(bucket_hash) do update
    set window_start=excluded.window_start,
        hits=case when public.rate_limits.window_start=excluded.window_start then public.rate_limits.hits+1 else 1 end,
        expires_at=excluded.expires_at
  returning hits into v_hits;
  v_retry:=greatest(1,ceil(extract(epoch from(v_start+make_interval(secs=>p_window_seconds)-v_now)))::integer);
  return query select v_hits<=p_limit,v_retry;
end;
$$;

create or replace function public.app_list_week(p_session_hash text,p_week_key text)
returns table(day_index integer,slot_index integer,mark_count bigint,mine boolean)
language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;
begin
  v_actor:=app_private.assert_actor(p_session_hash,false);
  perform app_private.assert_week_window(p_week_key,-8,4);
  return query
  select m.day_index,m.slot_index,count(*)::bigint,bool_or(m.user_id=v_actor)
  from public.marks m join public.profiles p on p.id=m.user_id and p.status='active'
  where m.week_key=p_week_key and m.deleted_at is null
  group by m.day_index,m.slot_index;
end;
$$;

create or replace function public.app_list_cell(p_session_hash text,p_week_key text,p_day_index integer,p_slot_index integer,
  p_before_created_at timestamptz default null,p_before_id uuid default null,p_page_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_total bigint;v_items jsonb;v_more boolean;
begin
  v_actor:=app_private.assert_actor(p_session_hash,false);
  perform app_private.assert_week_window(p_week_key,-8,4);
  if p_day_index not between 0 and 6 or p_slot_index not between 0 and 3 or p_page_size not between 1 and 50 then
    raise exception 'invalid cell request' using errcode='22023';
  end if;
  select count(*) into v_total from public.marks m join public.profiles p on p.id=m.user_id and p.status='active'
  where m.week_key=p_week_key and m.day_index=p_day_index and m.slot_index=p_slot_index and m.deleted_at is null;
  with page as (
    select m.id,m.user_id,m.nickname,m.location,m.created_at
    from public.marks m join public.profiles p on p.id=m.user_id and p.status='active'
    where m.week_key=p_week_key and m.day_index=p_day_index and m.slot_index=p_slot_index and m.deleted_at is null
      and (p_before_created_at is null or (m.created_at,m.id)<(p_before_created_at,p_before_id))
    order by m.created_at desc,m.id desc limit p_page_size+1
  ), numbered as(select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'nickname',nickname,'location',location,'created_at',created_at)
      order by created_at desc,id desc) filter(where rn<=p_page_size),'[]'::jsonb),
    coalesce(bool_or(rn>p_page_size),false) into v_items,v_more from numbered;
  return jsonb_build_object('items',v_items,'total',v_total,'hasMore',v_more);
end;
$$;

create or replace function public.app_upsert_marks(p_session_hash text,p_week_key text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_week date;v_count integer;v_changed integer;
begin
  v_actor:=app_private.assert_actor(p_session_hash,false);
  v_week:=app_private.assert_week_window(p_week_key,0,4);
  if jsonb_typeof(p_items)<>'array' then raise exception 'items must be an array' using errcode='22023'; end if;
  v_count:=jsonb_array_length(p_items);
  if v_count not between 1 and 28 then raise exception 'items must contain 1 to 28 cells' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as x(day_index integer,slot_index integer,nickname text,location text)
    where day_index is null or day_index not between 0 and 6 or slot_index is null or slot_index not between 0 and 3
      or nickname is null or length(btrim(nickname)) not between 1 and 30
      or (location is not null and length(btrim(location))>100)) then
    raise exception 'invalid mark item' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_items) as x(day_index integer,slot_index integer,nickname text,location text)
    group by day_index,slot_index having count(*)>1) then raise exception 'duplicate cell in request' using errcode='22023'; end if;
  with input as(
    select x.day_index,x.slot_index,btrim(x.nickname) nickname,coalesce(nullif(btrim(x.location),''),'皆可') location
    from jsonb_to_recordset(p_items) as x(day_index integer,slot_index integer,nickname text,location text)
  ), saved as(
    insert into public.marks(user_id,week_key,day_index,slot_index,nickname,location)
    select v_actor,p_week_key,i.day_index,i.slot_index,i.nickname,i.location from input i
    on conflict(user_id,week_key,day_index,slot_index) do update
      set nickname=excluded.nickname,location=excluded.location,deleted_at=null,updated_at=now()
      where (public.marks.nickname,public.marks.location,public.marks.deleted_at)
        is distinct from (excluded.nickname,excluded.location,null::timestamptz)
    returning 1
  ) select count(*) into v_changed from saved;
  return jsonb_build_object('accepted',v_count,'changed',v_changed,'week_key',p_week_key,'week_end',v_week+6);
end;
$$;

create or replace function public.app_delete_mark(p_session_hash text,p_mark_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_owner uuid;v_week text;v_count integer;
begin
  v_actor:=app_private.assert_actor(p_session_hash,false);
  select m.user_id,m.week_key into v_owner,v_week from public.marks m where m.id=p_mark_id and m.deleted_at is null for update;
  if not found then return 0; end if;
  if v_owner<>v_actor then raise exception 'forbidden' using errcode='42501'; end if;
  perform app_private.assert_week_window(v_week,0,4);
  update public.marks m set deleted_at=now(),updated_at=now() where m.id=p_mark_id and m.user_id=v_actor and m.deleted_at is null;
  get diagnostics v_count=row_count;
  return v_count;
end;
$$;

revoke all on function app_private.assert_week_window(text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function app_private.assert_actor(text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.app_auth_identity(text) from public,anon,authenticated;
revoke all on function public.app_device_registrations(text) from public,anon,authenticated;
revoke all on function public.app_register_session(uuid,text,bigint) from public,anon,authenticated;
revoke all on function public.app_get_session(text) from public,anon,authenticated;
revoke all on function public.app_revoke_session(text) from public,anon,authenticated;
revoke all on function public.app_consume_rate_limit(text,integer,integer) from public,anon,authenticated;
revoke all on function public.app_list_week(text,text) from public,anon,authenticated;
revoke all on function public.app_list_cell(text,text,integer,integer,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_upsert_marks(text,text,jsonb) from public,anon,authenticated;
revoke all on function public.app_delete_mark(text,uuid) from public,anon,authenticated;
grant execute on function public.app_auth_identity(text) to service_role;
grant execute on function public.app_device_registrations(text) to service_role;
grant execute on function public.app_register_session(uuid,text,bigint) to service_role;
grant execute on function public.app_get_session(text) to service_role;
grant execute on function public.app_revoke_session(text) to service_role;
grant execute on function public.app_consume_rate_limit(text,integer,integer) to service_role;
grant execute on function public.app_list_week(text,text) to service_role;
grant execute on function public.app_list_cell(text,text,integer,integer,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_upsert_marks(text,text,jsonb) to service_role;
grant execute on function public.app_delete_mark(text,uuid) to service_role;

commit;
