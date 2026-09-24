begin;

create or replace function public.app_prune_security_data()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_sessions integer;v_limits integer;
begin
  delete from public.app_sessions
    where expires_at<now()-interval '1 day'
       or (revoked_at is not null and revoked_at<now()-interval '7 days');
  get diagnostics v_sessions=row_count;
  delete from public.rate_limits where expires_at<now();
  get diagnostics v_limits=row_count;
  return jsonb_build_object('sessions',v_sessions,'rate_limits',v_limits);
end;
$$;

-- Reassert least privilege for every application RPC after all functions have been installed.
revoke all on function app_private.is_monday_week_key(text) from public,anon,authenticated,service_role;
revoke all on function app_private.assert_week_window(text,integer,integer) from public,anon,authenticated,service_role;
revoke all on function app_private.assert_actor(text,boolean) from public,anon,authenticated,service_role;
revoke all on function app_private.on_auth_user_created() from public,anon,authenticated,service_role;

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
revoke all on function public.app_admin_list_users(text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_admin_list_audit(text,timestamptz,bigint,integer) from public,anon,authenticated;
revoke all on function public.app_admin_action(text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.app_admin_finish_password_reset(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.app_admin_fail_password_reset(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.app_admin_marks_action(text,text,text,uuid[],text) from public,anon,authenticated;
revoke all on function public.app_admin_list_deleted_marks(text,text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_admin_week_active_count(text,text) from public,anon,authenticated;
revoke all on function public.app_admin_list_active_marks(text,text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.app_prune_security_data() from public,anon,authenticated;
revoke all on function public.app_bootstrap_first_admin(text) from public,anon,authenticated;

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
grant execute on function public.app_admin_list_users(text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_admin_list_audit(text,timestamptz,bigint,integer) to service_role;
grant execute on function public.app_admin_action(text,uuid,text,text) to service_role;
grant execute on function public.app_admin_finish_password_reset(text,uuid,uuid,text) to service_role;
grant execute on function public.app_admin_fail_password_reset(text,uuid,uuid) to service_role;
grant execute on function public.app_admin_marks_action(text,text,text,uuid[],text) to service_role;
grant execute on function public.app_admin_list_deleted_marks(text,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_admin_week_active_count(text,text) to service_role;
grant execute on function public.app_admin_list_active_marks(text,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.app_prune_security_data() to service_role;
grant execute on function public.app_bootstrap_first_admin(text) to service_role;

commit;
