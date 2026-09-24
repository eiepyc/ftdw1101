# 生产部署与运维

本文覆盖上线、维护、备份恢复、密码重置异常及回滚。先在独立测试 Supabase 项目和非生产域名完成整套演练，再安排生产切换。不要把真实密钥、Cookie、密码或原始 Auth 响应放入工单、命令历史或日志。

## 部署拓扑与首次上线

建议把应用容器部署在香港或新加坡区域的 Linux 主机上，Supabase 项目选择支持的亚洲区域；当前 Supabase 区域清单没有香港选项，香港应用连接新加坡或东京数据库会产生跨区延迟。可在腾讯云香港/新加坡等节点部署；中国大陆用户的连通性仍须使用当地真实运营商网络验收，不能从云厂商区域清单推断。Cloudflare 中国网络是独立的企业产品，Turnstile 在中国大陆网络不应作为可用前提。[Supabase 区域列表](https://supabase.com/docs/guides/platform/regions)、[腾讯云区域列表](https://www.tencentcloud.com/document/product/213/6091)、[Cloudflare 中国网络](https://developers.cloudflare.com/china-network/)、[Turnstile 中国网络常见问题](https://developers.cloudflare.com/china-network/faq/)

1. 创建独立的 Supabase 测试和生产项目，记录实际区域、项目引用、备份/PITR保留期、Auth 限流和密码最小长度设置。只开放应用的 80/443 入口；Next.js 端口保持 Compose 私有网络内，不要添加主机端口映射。
2. 在可信终端复制 `.env.example` 为 `.env`，填写 `APP_ORIGIN`、`PUBLIC_DOMAIN`、`SUPABASE_URL`、service role 密钥，以及分别生成的 `SESSION_HASH_SECRET`、`DEVICE_SIGNING_SECRET`、`DEVICE_HASH_SECRET`、`RATE_LIMIT_HMAC_SECRET`。四个秘密不可复用；示例占位文本会被应用拒绝。备份 `.env` 到受控密钥管理系统，不放入 Git 或普通备份归档。
3. 检查 APP_ORIGIN=https://<正式域名> 和 PUBLIC_DOMAIN=<同一域名> 一致。Compose 将 APP_PROXY_MODE=caddy，因为 Caddy 位于可信内网，并且覆盖 X-Real-IP 为 TCP 对端地址；不可让未经信任的容器连接 app 网络，也不可公开 app 端口。
4. 先在 Supabase 配置 Auth 密码最小长度 8 和上游认证速率限制，再将四份 `supabase/migrations/` 按顺序应用。CLI 首次使用时先执行 `supabase init` 并检查配置，随后 `supabase link --project-ref <project-ref>`，再执行 `supabase migration up --linked`；也可在项目 SQL Editor 按文件顺序执行。每个 migration 完整成功后才继续。不要执行旧版浏览器 RLS/schema 指南。
5. 在生产域名完成 TLS/DNS 后部署：

   ```powershell
   docker compose config --quiet
   docker compose build app
   docker image tag team-slots:local team-slots:<release-tag>
   $env:APP_IMAGE = "team-slots:<release-tag>"
   docker compose up -d --no-build
   docker compose ps
   docker compose logs --tail 100 app caddy
   ```

   Caddy 管理证书；检查 `/api/health` 返回健康状态。健康检查只确认配置格式和进程可用，不会测试 Supabase Auth 或数据库连通性。使用测试账号验证注册、登录、提交、登出、管理员操作；不要用真实用户或向外部发送邮件做演练。
6. 生产首位管理员须先经公开页面注册，再按 [Supabase 安装说明](../supabase/README.md) 从受信任终端执行一次性 `scripts/bootstrap-admin.mjs`。该脚本只提升已有活动账号。

## 定时清理

`app_prune_security_data()` 是 service-role-only 的受限函数，只删除过期的应用会话和限流桶，不修改账号、登记或审计记录。建议每日运行一次，并监控退出状态；以环境变量注入 Compose 配置的方式运行，不在命令行参数写密钥：

```sh
docker compose exec -T app node /app/scripts/prune-security-data.mjs
```

可由受控的 systemd timer、任务调度器或运维平台按日触发。该 job 不应公开成 HTTP 路由。数据库备份另行保留；清理作业不能代替备份。

## 未知结果的管理员密码重置

应用在 Supabase Auth 更新请求出现超时或网络中断时会让账号保持 `reset_pending`，撤销其会话并拒绝登录。未知结果不能靠等待时长、安全 cookie 或再次点击重置来判断；不要添加自动超时解锁，也不要对仍可能在途的上游请求启动第二次密码更新。

只有在可信运维人员已确认旧请求终止、不会再晚到提交，并且能通过 Auth 管理界面/API 将目标账号密码重新设置为一个已知的新密码后，才可人工恢复：

1. 通过审计中的用户名和 `profiles.id` 确认目标账号；读取当前 `password_reset_attempt` UUID。不要查询或导出邮箱、密码哈希、Auth token，也不要把尝试 UUID 贴入工单。
2. 检查应用日志和运维任务，确认没有运行中的 Auth 密码修改请求。若无法确认这一点，停止并让账号继续处于 `reset_pending`。
3. 在托管 Supabase Auth 管理界面或受控 Admin API 中，将密码再设一次为操作员已知的新密码；按应用密码规则（至少 8 个 Unicode 码点、一个 A–Z 大写字母、一个标点、最多 72 UTF-8 字节）设置，并验证该密码确实能通过 Auth 验证。密码不要写进 SQL 或日志。
4. 由具备数据库 owner/operator 权限的指定人员，在 Supabase SQL Editor 中执行如下受控事务。把三个 UUID 和审计原因替换为实际值；actor 必须是另一位仍处于 active 的管理员。脚本取得与应用管理员动作相同的事务级 advisory lock，精确匹配当前 attempt，只能恢复一条仍 pending 的目标记录；任何条件不符都回滚。此恢复会增加 `auth_epoch`、确保旧会话撤销，并记录审计事件：

   ```sql
   begin;
   do $recovery$
   declare
     v_actor uuid := '<active-admin-profile-uuid>';
     v_target uuid := '<pending-user-profile-uuid>';
     v_attempt uuid := '<current-password-reset-attempt-uuid>';
     v_count integer;
   begin
     perform pg_advisory_xact_lock(hashtextextended('admin-action', 0));
     if v_actor = v_target or not exists (
       select 1 from public.profiles
       where id = v_actor and role = 'admin' and status = 'active'
     ) then
       raise exception 'operator must be a different active administrator';
     end if;
     update public.profiles
       set status = 'active', auth_epoch = auth_epoch + 1,
           password_reset_attempt = null, password_reset_started_at = null,
           updated_at = now()
       where id = v_target and status = 'reset_pending'
         and password_reset_attempt = v_attempt;
     get diagnostics v_count = row_count;
     if v_count <> 1 then
       raise exception 'reset attempt changed or account is not pending';
     end if;
     update public.app_sessions
       set revoked_at = coalesce(revoked_at, now())
       where user_id = v_target and revoked_at is null;
     insert into public.audit_log(actor_user_id, target_user_id, action, reason, affected_count)
       values (v_actor, v_target, 'complete_password_reset',
               'operator recovery after verifying Auth password update', 1);
   end
   $recovery$;
   commit;
   ```

5. 验证旧会话失效、目标用户可以用刚刚设定的密码登录，再从审计页面核对恢复事件。若事务失败，保留 pending 状态并调查；不要改用无条件 `UPDATE` 清状态。

## 备份、恢复与镜像回滚

- 在 Supabase 控制台核对当前套餐可用的自动备份或 PITR 功能、频率、保留期限和恢复点范围；生产数据变化后重新核对。必要时按 Supabase 文档配置付费备份/PITR。备份必须位于受控、加密、访问审计的存储中，并定期在隔离的恢复项目演练。不要假设仅导出 `public` 就能恢复 Auth 用户与其关系，也不要直接导入托管 `auth` schema；确认 Supabase 当前支持的恢复流程和涵盖范围。[Supabase 数据库备份文档](https://supabase.com/docs/guides/platform/backups)
- 生产上线前指定 RPO/RTO、数据恢复审批人及只读维护窗口。恢复前冻结写入；优先使用托管 PITR 恢复到独立项目，检查 profiles、marks、audit_log 与 Auth 身份对应后再切换应用配置。恢复完成执行管理员登录、用户登录、登记读写与管理员审计验收。保留原项目只读，直到业务负责人确认新实例数据完整。
- 每个版本用不可变 release tag 保存应用镜像，并记录源代码版本、镜像摘要、migration 版本和配置版本。回滚应用时只切回上一个应用镜像：

  ```sh
  APP_IMAGE=team-slots:<previous-release-tag> docker compose up -d --no-build app
  docker compose ps
  docker compose logs --tail 100 app
  ```

  SQL migration 应保持向前兼容；应用镜像回滚不会回滚数据库。只有在已验证独立数据库恢复点、获授权且明确评估数据丢失影响后，才恢复数据库备份/PITR，不能把生产数据库直接降级到旧 schema。
- 每季度至少演练一次镜像回滚与数据库恢复；演练数据使用独立测试项目，不向真实用户发送通知。

## 地域和网络验收

应用不载入第三方字体、验证码或 Auth 重定向，可减少额外跨域依赖；这不证明任意地区的网络质量。首次上线以及主要 DNS、代理、Supabase 区域变更后，安排真实网络矩阵测试：香港、澳门、新加坡、日本，以及中国电信、联通、移动的实际大陆网络分别记录日期、运营商、网络类型、浏览器、DNS/TLS 成功率、登录/写入/读取成功率、错误码和 P95。每个试点至少对 20 次操作逐项记录；20/20 只是小样本试点通过，不代表长期可用性 SLA。确认地区部署、域名备案或企业网络要求前，不要宣传“大陆稳定可用”。

## 事件与停止条件

遇到迁移失败、设备配额与 Profile 不一致、账号身份映射冲突、未知 Auth 密码更新结果、last-admin 锁定或无法确认备份覆盖时，保留当前数据和状态，暂停后续变更，先从受控备份与审计信息调查。不得直接删除 Auth 用户、重建重复 username、手工解除 pending、或在不确定的恢复点上覆盖生产数据库。
