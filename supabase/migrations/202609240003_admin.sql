begin;

create or replace function public.app_admin_list_users(p_session_hash text,p_before_created_at timestamptz default null,p_before_id uuid default null,p_page_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_items jsonb;v_total bigint;v_more boolean;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  if p_page_size not between 1 and 100 then raise exception 'invalid page size' using errcode='22023'; end if;
  select count(*) into v_total from public.profiles;
  with page as(
    select p.id,p.username,p.role,p.status,p.created_at,p.deleted_at,
      (select count(*) from public.marks m where m.user_id=p.id and m.deleted_at is null) active_marks
    from public.profiles p
    where p_before_created_at is null or (p.created_at,p.id)<(p_before_created_at,p_before_id)
    order by p.created_at desc,p.id desc limit p_page_size+1
  ), numbered as(select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'username',username,'role',role,'status',status,
      'created_at',created_at,'deleted_at',deleted_at,'active_marks',active_marks) order by created_at desc,id desc)
      filter(where rn<=p_page_size),'[]'::jsonb),
    coalesce(bool_or(rn>p_page_size),false) into v_items,v_more from numbered;
  return jsonb_build_object('items',v_items,'total',v_total,'hasMore',v_more);
end;
$$;

create or replace function public.app_admin_list_audit(p_session_hash text,p_before_created_at timestamptz default null,p_before_id bigint default null,p_page_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_items jsonb;v_total bigint;v_more boolean;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  if p_page_size not between 1 and 100 then raise exception 'invalid page size' using errcode='22023'; end if;
  select count(*) into v_total from public.audit_log;
  with page as(
    select a.id,ap.username actor_username,tp.username target_username,a.action,a.reason,a.affected_count,a.created_at
    from public.audit_log a left join public.profiles ap on ap.id=a.actor_user_id left join public.profiles tp on tp.id=a.target_user_id
    where p_before_created_at is null or (a.created_at,a.id)<(p_before_created_at,p_before_id)
    order by a.created_at desc,a.id desc limit p_page_size+1
  ), numbered as(select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'actor_username',actor_username,'target_username',target_username,
      'action',action,'reason',reason,'affected_count',affected_count,'created_at',created_at) order by created_at desc,id desc)
      filter(where rn<=p_page_size),'[]'::jsonb),
    coalesce(bool_or(rn>p_page_size),false) into v_items,v_more from numbered;
  return jsonb_build_object('items',v_items,'total',v_total,'hasMore',v_more);
end;
$$;

create or replace function public.app_admin_action(p_session_hash text,p_target_user_id uuid,p_action text,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_target_role text;v_target_status text;v_count integer:=0;v_admins integer;v_reset_attempt uuid;
begin
  if p_reason is null or length(btrim(p_reason)) not between 4 and 300 then raise exception 'reason must be 4 to 300 characters' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-action',0));
  v_actor:=app_private.assert_actor(p_session_hash,true);
  select p.role,p.status into v_target_role,v_target_status from public.profiles p where p.id=p_target_user_id for update;
  if not found then raise exception 'user not found' using errcode='P0002'; end if;
  if p_action in ('ban','delete','demote_admin','prepare_password_reset') and v_target_role='admin' and v_target_status='active' then
    select count(*) into v_admins from public.profiles where role='admin' and status='active';
    if v_admins<=1 then raise exception 'cannot disable the last active administrator' using errcode='23514'; end if;
  end if;
  if v_actor=p_target_user_id and p_action in ('ban','delete','demote_admin','prepare_password_reset') then
    raise exception 'cannot perform this action on yourself' using errcode='42501';
  end if;
  if p_action='ban' then
    update public.profiles set status='banned',auth_epoch=auth_epoch+1,updated_at=now() where id=p_target_user_id and status='active';
  elsif p_action='unban' then
    update public.profiles set status='active',auth_epoch=auth_epoch+1,updated_at=now() where id=p_target_user_id and status='banned';
  elsif p_action='delete' then
    update public.profiles set status='deleted',deleted_at=now(),auth_epoch=auth_epoch+1,updated_at=now() where id=p_target_user_id and status in ('active','banned');
  elsif p_action='restore' then
    update public.profiles set status='active',deleted_at=null,auth_epoch=auth_epoch+1,updated_at=now() where id=p_target_user_id and status='deleted';
  elsif p_action='promote_admin' then
    update public.profiles set role='admin',updated_at=now() where id=p_target_user_id and role<>'admin';
  elsif p_action='demote_admin' then
    update public.profiles set role='user',updated_at=now() where id=p_target_user_id and role='admin';
  elsif p_action='prepare_password_reset' then
    update public.profiles set status='reset_pending',auth_epoch=auth_epoch+1,
      password_reset_attempt=gen_random_uuid(),password_reset_started_at=now(),updated_at=now()
      where id=p_target_user_id and (status='active' or (status='reset_pending' and password_reset_attempt is null))
      returning password_reset_attempt into v_reset_attempt;
  else raise exception 'unsupported admin action' using errcode='22023';
  end if;
  get diagnostics v_count=row_count;
  if p_action in ('ban','delete','prepare_password_reset') and v_count>0 then
    update public.app_sessions set revoked_at=coalesce(revoked_at,now()) where user_id=p_target_user_id and revoked_at is null;
  end if;
  insert into public.audit_log(actor_user_id,target_user_id,action,reason,affected_count)
    values(v_actor,p_target_user_id,p_action,btrim(p_reason),v_count);
  return jsonb_build_object('target_user_id',p_target_user_id,'affected_count',v_count,
    'status',(select status from public.profiles where id=p_target_user_id),
    'role',(select role from public.profiles where id=p_target_user_id),
    'reset_attempt',v_reset_attempt);
end;
$$;

create or replace function public.app_admin_finish_password_reset(p_session_hash text,p_target_user_id uuid,p_attempt_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_count integer;
begin
  if p_reason is null or length(btrim(p_reason)) not between 4 and 300 then raise exception 'reason must be 4 to 300 characters' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('admin-action',0));
  v_actor:=app_private.assert_actor(p_session_hash,true);
  if v_actor=p_target_user_id then raise exception 'cannot reset your own password here' using errcode='42501'; end if;
  update public.profiles set status='active',auth_epoch=auth_epoch+1,password_reset_attempt=null,
    password_reset_started_at=null,updated_at=now()
  where id=p_target_user_id and status='reset_pending' and password_reset_attempt=p_attempt_id;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'password reset is not pending' using errcode='23514'; end if;
  insert into public.audit_log(actor_user_id,target_user_id,action,reason,affected_count)
  values(v_actor,p_target_user_id,'complete_password_reset',btrim(p_reason),1);
  return jsonb_build_object('target_user_id',p_target_user_id,'status','active');
end;
$$;

create or replace function public.app_admin_fail_password_reset(p_session_hash text,p_target_user_id uuid,p_attempt_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin-action',0));
  v_actor:=app_private.assert_actor(p_session_hash,true);
  if v_actor=p_target_user_id then raise exception 'cannot reset your own password here' using errcode='42501'; end if;
  update public.profiles set password_reset_attempt=null,password_reset_started_at=null,updated_at=now()
    where id=p_target_user_id and status='reset_pending' and password_reset_attempt=p_attempt_id;
  get diagnostics v_count=row_count;
  if v_count=1 then
    insert into public.audit_log(actor_user_id,target_user_id,action,reason,affected_count)
      values(v_actor,p_target_user_id,'password_reset_upstream_failed','upstream password update did not complete',1);
  end if;
  return v_count;
end;
$$;

create or replace function public.app_admin_marks_action(p_session_hash text,p_action text,p_week_key text,p_mark_ids uuid[] default null,p_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_count integer;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  perform app_private.assert_week_window(p_week_key,-8,4);
  if p_reason is null or length(btrim(p_reason)) not between 4 and 300 then raise exception 'reason must be 4 to 300 characters' using errcode='22023'; end if;
  if p_action='clear_week' then
    perform app_private.assert_week_window(p_week_key,0,4);
    update public.marks set deleted_at=now(),updated_at=now() where week_key=p_week_key and deleted_at is null;
  elsif p_action='delete_marks' then
    if p_mark_ids is null or cardinality(p_mark_ids) not between 1 and 100 then raise exception 'select 1 to 100 marks' using errcode='22023'; end if;
    update public.marks set deleted_at=now(),updated_at=now()
      where id=any(p_mark_ids) and week_key=p_week_key and deleted_at is null;
  elsif p_action='restore_marks' then
    if p_mark_ids is null or cardinality(p_mark_ids) not between 1 and 100 then raise exception 'select 1 to 100 marks' using errcode='22023'; end if;
    update public.marks set deleted_at=null,updated_at=now()
      where id=any(p_mark_ids) and week_key=p_week_key and deleted_at is not null;
  else raise exception 'unsupported marks action' using errcode='22023'; end if;
  get diagnostics v_count=row_count;
  insert into public.audit_log(actor_user_id,action,reason,affected_count)
    values(v_actor,'marks_'||p_action||':'||p_week_key,btrim(p_reason),v_count);
  return v_count;
end;
$$;

create or replace function public.app_admin_list_deleted_marks(p_session_hash text,p_week_key text,p_before_created_at timestamptz default null,p_before_id uuid default null,p_page_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_items jsonb;v_total bigint;v_more boolean;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  perform app_private.assert_week_window(p_week_key,-8,4);
  if p_page_size not between 1 and 100 then raise exception 'invalid page size' using errcode='22023'; end if;
  select count(*) into v_total from public.marks where week_key=p_week_key and deleted_at is not null;
  with page as(
    select m.id,m.user_id,p.username,m.day_index,m.slot_index,m.nickname,m.location,m.created_at,m.deleted_at
    from public.marks m join public.profiles p on p.id=m.user_id
    where m.week_key=p_week_key and m.deleted_at is not null
      and (p_before_created_at is null or (m.created_at,m.id)<(p_before_created_at,p_before_id))
    order by m.created_at desc,m.id desc limit p_page_size+1
  ), numbered as(select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'username',username,'day_index',day_index,
      'slot_index',slot_index,'nickname',nickname,'location',location,'created_at',created_at,'deleted_at',deleted_at)
      order by created_at desc,id desc) filter(where rn<=p_page_size),'[]'::jsonb),
    coalesce(bool_or(rn>p_page_size),false) into v_items,v_more from numbered;
  return jsonb_build_object('items',v_items,'total',v_total,'hasMore',v_more);
end;
$$;

create or replace function public.app_admin_week_active_count(p_session_hash text,p_week_key text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_count bigint;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  perform app_private.assert_week_window(p_week_key,-8,4);
  select count(*) into v_count from public.marks where week_key=p_week_key and deleted_at is null;
  return v_count;
end;
$$;

create or replace function public.app_admin_list_active_marks(p_session_hash text,p_week_key text,p_before_created_at timestamptz default null,p_before_id uuid default null,p_page_size integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid;v_items jsonb;v_total bigint;v_more boolean;
begin
  v_actor:=app_private.assert_actor(p_session_hash,true);
  perform app_private.assert_week_window(p_week_key,-8,4);
  if p_page_size not between 1 and 100 then raise exception 'invalid page size' using errcode='22023'; end if;
  select count(*) into v_total from public.marks where week_key=p_week_key and deleted_at is null;
  with page as(
    select m.id,m.user_id,p.username,m.day_index,m.slot_index,m.nickname,m.location,m.created_at,m.deleted_at
    from public.marks m join public.profiles p on p.id=m.user_id
    where m.week_key=p_week_key and m.deleted_at is null
      and (p_before_created_at is null or (m.created_at,m.id)<(p_before_created_at,p_before_id))
    order by m.created_at desc,m.id desc limit p_page_size+1
  ), numbered as(select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'user_id',user_id,'username',username,'day_index',day_index,
      'slot_index',slot_index,'nickname',nickname,'location',location,'created_at',created_at,'deleted_at',deleted_at)
      order by created_at desc,id desc) filter(where rn<=p_page_size),'[]'::jsonb),
    coalesce(bool_or(rn>p_page_size),false) into v_items,v_more from numbered;
  return jsonb_build_object('items',v_items,'total',v_total,'hasMore',v_more);
end;
$$;

create or replace function public.app_bootstrap_first_admin(p_username text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid;
begin
  perform 1 from public.bootstrap_state where id=true for update;
  if (select consumed_at from public.bootstrap_state where id=true) is not null then
    raise exception 'initial administrator bootstrap has already been used' using errcode='42501';
  end if;
  select id into v_user from public.profiles where username=lower(p_username) and status='active' for update;
  if v_user is null then raise exception 'active account not found' using errcode='P0002'; end if;
  if exists(select 1 from public.profiles where role='admin' and status='active') then raise exception 'active administrator already exists' using errcode='23505'; end if;
  update public.profiles set role='admin',updated_at=now() where id=v_user;
  update public.bootstrap_state set consumed_at=now() where id=true;
  insert into public.audit_log(actor_user_id,target_user_id,action,reason,affected_count)
    values(null,v_user,'bootstrap_first_admin','explicit one-time operator bootstrap',1);
  return v_user;
end;
$$;

revoke all on function public.app_admin_list_users(text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_admin_list_audit(text,timestamptz,bigint,integer) from public,anon,authenticated;
revoke all on function public.app_admin_action(text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.app_admin_finish_password_reset(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.app_admin_fail_password_reset(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.app_admin_marks_action(text,text,text,uuid[],text) from public,anon,authenticated;
revoke all on function public.app_admin_list_deleted_marks(text,text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_admin_week_active_count(text,text) from public,anon,authenticated;
revoke all on function public.app_admin_list_active_marks(text,text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_bootstrap_first_admin(text) from public,anon,authenticated;
grant execute on function public.app_admin_list_users(text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_admin_list_audit(text,timestamptz,bigint,integer) to service_role;
grant execute on function public.app_admin_action(text,uuid,text,text) to service_role;
grant execute on function public.app_admin_finish_password_reset(text,uuid,uuid,text) to service_role;
grant execute on function public.app_admin_fail_password_reset(text,uuid,uuid) to service_role;
grant execute on function public.app_admin_marks_action(text,text,text,uuid[],text) to service_role;
grant execute on function public.app_admin_list_deleted_marks(text,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_admin_week_active_count(text,text) to service_role;
grant execute on function public.app_admin_list_active_marks(text,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_bootstrap_first_admin(text) to service_role;

commit;
