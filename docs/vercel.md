# Vercel Hobby 部署

本文记录 `codex/vercel-deploy` 分支的 Vercel Hobby 部署设置。Supabase Free 项目已创建在东京区域（`ap-northeast-1`）且状态为 Healthy；Vercel 登录已完成，但 GitHub App 仓库安装权限仍待核实。数据库迁移和生产发布尚未完成；本地适配不表示线上部署已验证。

## 项目设置

- 从 GitHub 导入 `K1tKaLL0s/ftdw1101`，生产分支设为 `codex/vercel-deploy`，根目录保持仓库根目录。该仓库按用户选择从 `eiepyc/ftdw1101` 复制到当前个人账号；GitHub App 仅授权这一仓库，不选 All repositories。`main` 仍为原始版本，不能用它部署当前已加固的应用。
- 使用 Node.js 24。仓库中的 `vercel.json` 设定 Next.js 框架、`npm ci` 安装命令及 `npm run build:vercel` 构建命令。
- `build:vercel` 会设置仅用于本次构建的 `VERCEL_BUILD=1`，Next.js 输出原生 `.next` 产物，不生成 Docker 使用的 standalone 目录。Docker 的 `build` 和 EdgeOne 的 `build:edgeone` 保持独立。
- 不在仓库配置函数区域。在 Vercel 项目设置中将函数区域设为 Tokyo（`hnd1`），与 Supabase 项目所在的东京区域（`ap-northeast-1`）相近。区域值只在部署项目设置中使用，不写入 `vercel.json`。

## 环境变量与安全边界

先从 Vercel 项目分配的免费生产域名中选定规范网址，再将完全相同的 HTTPS origin 配置为生产环境 `APP_ORIGIN`。应用不会根据请求 `Host` 自动推导可信来源。若之后更换生产网址，必须同步更新 `APP_ORIGIN` 并重新部署。

将以下 8 个变量只添加到 Vercel 的 Production 环境：

- `APP_ORIGIN`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SESSION_HASH_SECRET`
- `DEVICE_SIGNING_SECRET`
- `DEVICE_HASH_SECRET`
- `RATE_LIMIT_HMAC_SECRET`
- `APP_PROXY_MODE=vercel`

四个应用秘密必须分别生成至少 32 字节的随机值，不得彼此复用。Supabase service role key 只能用于服务端运行时；不得使用 `NEXT_PUBLIC_` 前缀、提交到仓库、加入客户端代码或放入构建日志。Preview 环境不得复制生产密钥；只有为临时、隔离数据库明确配置一套单独密钥时才可运行需要数据库的 Preview。Vercel Hobby 自动为推送创建 Preview；不配置 Preview 秘密时，需把它视作不可连接生产数据库的预览构建。

`APP_PROXY_MODE=vercel` 只读取 Vercel 提供的 `x-vercel-forwarded-for`，并只接受单个合法 IPv4 或 IPv6。缺失、非法或包含地址列表时使用共享限流桶，不读取 `x-forwarded-for`、`x-real-ip` 或其他客户端可提供的头。该模式只适用于直接部署在 Vercel 的服务；不要让另一个反向代理把请求转发到此部署。

## 数据库初始化与首个管理员

Supabase 项目创建后，按文件名顺序应用 `supabase/migrations/` 下四个迁移：

1. `202609240001_schema.sql`
2. `202609240002_auth_and_marks.sql`
3. `202609240003_admin.sql`
4. `202609240004_privileges.sql`

部署前检查远端迁移历史与仓库一致，避免同一迁移通过控制台和 GitHub 集成重复执行。启用 Supabase Auth 密码登录，将最小密码长度设为 8，并设置 Auth 端登录/注册限流；不要强制应用不要求的小写字母或数字。应用 BFF 不能代替 Supabase Auth 自身的限流与注册触发器保护。

部署完成且健康端点可用后，通过公开注册流程创建首个用户；再在受信任管理员机器上按 [README 的管理员初始化步骤](../README.md#数据库和首位管理员)运行 `scripts/bootstrap-admin.mjs <existing-username>`。初始化一次后数据库会拒绝第二次提升首位管理员。不要将 service role key 粘贴到浏览器、聊天或代码仓库。

## 上线检查与回滚

首次生产部署后，检查 `https://<生产域名>/api/health` 返回 HTTP 200 和 `{"status":"ok"}`，并确认响应包含 `Cache-Control: no-store`。随后按独立上线计划验证 CSP、Cookie、未登录拒绝、注册/登录、第二与第三账号设备配额、场地登记、管理员操作、审计记录以及绕过应用直接调用 Supabase Auth 注册时的数据库拒绝。也要从预期地区实际测试访问效果；大陆网络尚未验证，不要把未测路径报告为可用。

若新版本有问题，将 Vercel Production 回滚到上一个已知可用的应用部署，并保留数据库数据。除非已另行验证前向/回滚兼容性，不要用回滚应用去反向执行数据库迁移。

## 免费计划限制

Vercel Hobby 免费方案面向个人、非商业用途，且不能把 Hobby 项目连接到由 GitHub 组织拥有的仓库；目标仓库是个人账号所有，但授权账号仍需具备访问权。Hobby 还受月度用量和构建限制，超限后部分功能可能暂停直至额度恢复。请在[计划说明](https://vercel.com/docs/plans/hobby)和[限制说明](https://vercel.com/docs/limits)核对最新限制。

Supabase Free 当前额度包括每个项目 500 MB 数据库、5 GB 出站流量、50,000 月活用户和 1 GB 文件存储；连续 7 天低活动的项目可能自动暂停，免费方案也不含分支数据库。超过免费额度可能触发服务限制。应定期检查[计费额度](https://supabase.com/docs/guides/platform/billing-on-supabase)并为业务数据保留独立备份；自动暂停规则见[项目暂停说明](https://supabase.com/docs/guides/platform/free-project-pausing)。这些额度可能变化，应以供应商当前文档和项目控制台为准。
