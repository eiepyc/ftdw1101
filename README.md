# 来牌

来牌是一个共享时段登记应用。用户以用户名和密码加入同一张登记表；登录、登记、账号管理和数据读取均由同源 Next.js 后端处理。浏览器不会连接 Supabase 数据库，也不会接触 service role 密钥。

## 本地运行

本地开发推荐 Node.js 24 和 npm；应用兼容 Node.js 20.19 及以上的 20.x、22.11 及以上的 22.x 和 24.x。EdgeOne 构建固定使用 Node.js 24.5.0。复制 `.env.example` 为 `.env.local`，填写 Supabase 项目 URL、服务端 service role key、公开地址以及四个独立随机秘密。不要填写 `NEXT_PUBLIC_` 前缀，也不要提交 `.env.local`。

```powershell
npm ci
npm run dev
```

打开 `http://localhost:3000`。本地 `APP_ORIGIN` 必须与浏览器访问地址完全相同，例如 `http://localhost:3000`；生产环境须使用 HTTPS 的规范域名。

## 数据库和首位管理员

按顺序应用 `supabase/migrations/` 中四个迁移。旧的 `supabase/schema.sql` 现在只是入口说明；请勿运行早期直接浏览器访问、anon key 与 RLS 策略方案。

部署后先从公开注册流程创建首个账号，再在受信任的管理员机器上执行一次性初始化：

```powershell
$env:SUPABASE_URL = "https://project-ref.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service-role-secret>"
node scripts/bootstrap-admin.mjs first_username
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
```

该脚本只会把已存在的活动用户提升为首位管理员，不创建用户、不发邮件；数据库也会拒绝第二次初始化。service role 只允许出现在服务端环境和此受控 CLI 命令中，不能放到浏览器变量或版本库里。

## Supabase Auth 配置

在托管项目启用密码登录，将最小密码长度设为 8，并设置 Auth 服务端的登录/注册速率限制。新建和管理员重置密码由应用执行以下规则：至少 8 个 Unicode 码点、至少一个大写英文字母、至少一个可打印 ASCII 标点符号、UTF-8 总长度最多 72 字节；不要求小写字母或数字。登录仍接受旧账号的短密码，不会 trim 密码。

Supabase 托管 Auth 的字符要求选项不支持“只要求大写+标点”这一组合。不要在控制台额外要求小写字母或数字。应用 BFF 的速率限制保护应用请求，但 Supabase Auth 的公开端点仍能被直接访问，因此还要配置上游 Auth 限流，并上线后检查：直接调用 Auth 注册接口绕过应用时，应由数据库 Auth 触发器拒绝并回滚。PGlite 测试验证了迁移 SQL 和触发器逻辑，但不等同于真实托管 Supabase Auth 联调。

## 设备登记限制和隐私

公开注册；单个浏览器设备最多关联两个注册账号。设备标记来自随机值与服务端签名 cookie 的摘要，不读取硬件指纹。清除该浏览器 cookie 或使用另一浏览器会形成新的设备标记，所以这不是“每个自然人两个账号”的承诺。数据库触发器在事务里执行限额检查和 profile 建立，直接 Auth 注册不能绕过该限制。应用使用 opaque cookie session；上游 Supabase access/refresh token 不发送到浏览器。

## 部署

仓库保留 Docker/Caddy、EdgeOne Pages 和 Vercel 三种部署路径。EdgeOne Next.js 全栈部署步骤、环境变量和上线前平台检查见 [EdgeOne 部署说明](docs/edgeone.md)；Vercel 部署步骤见 [Vercel 部署说明](docs/vercel.md)。两种托管路径都使用各自的构建命令，Docker standalone 输出仍由 npm run build 生成。

Docker 部署使用仓库中的 Dockerfile、Compose 与 Caddy 配置。复制 .env.example 为 .env，配置真实 HTTPS 域名和全部服务端密钥，然后运行 docker compose up --build -d。反向代理只发布 80/443，Next.js 容器仅在 Compose 私有网络上监听；部署环境应启用持久备份、监控、补丁更新和托管 Auth 限流。

为每个秘密单独生成至少 32 字节随机值，例如 PowerShell：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

不要把真实密钥放入 .env.example、日志或工单。本地直连使用 APP_PROXY_MODE=none。Compose 显式使用 APP_PROXY_MODE=caddy，只信任 Caddy 覆盖的 X-Real-IP；旧版部署可在未设置 APP_PROXY_MODE 时用 TRUST_PROXY=true 选择 Caddy 模式。EdgeOne 与 Vercel 使用各自的专用代理模式，详情见 [EdgeOne 部署说明](docs/edgeone.md)和 [Vercel 部署说明](docs/vercel.md)。不要将 Next.js 端口公开到互联网或让不可信服务连接 Caddy 内网。Caddy 配置限制请求体，并设置读取头、读取体、写入和空闲超时。

## 管理功能与数据恢复

管理员可以封禁、恢复或软删除账号，调整管理员角色、重置密码，逐条软删除/恢复登记或按周清理登记。管理员操作需要填写原因并进入审计记录。账号软删除不会物理删除 Supabase Auth 用户；恢复账号也不会自动恢复已单独软删除的登记。应按部署清单定期备份数据库并演练恢复。

生产备份、维护清理、未知密码重置结果的安全恢复、镜像回滚及 HK/SG 部署验收步骤见 [`docs/operations.md`](docs/operations.md)。

## 所在场地

登记时昵称必填，所在场地选填；未填写或只输入空白时按“皆可”保存。一次选择多个时间段时，所有记录共用同一所在场地。

## 检查命令

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm audit
```

Playwright 测试必须在 build 之后运行，直接启动 Next standalone 产物；默认使用 Windows 已安装的 Chrome 或 Linux 的 Playwright Chromium。可通过 `PLAYWRIGHT_BROWSERS_PATH` 指定浏览器缓存目录。浏览器测试中的 API 拦截只验证 UI 状态和竞态处理，不验证真实 Supabase Auth。
