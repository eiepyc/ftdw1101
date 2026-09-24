# EdgeOne 部署

仓库提供 EdgeOne Pages 的 Next.js 全栈构建配置。项目使用服务端渲染和 Route Handlers，不能改成静态导出。edgeone.json 固定安装命令为 npm ci、构建命令为 npm run build:edgeone，构建输出为 .next，构建 Node.js 为 24.5.0。Cloud Functions 的境外区域设为新加坡，并把 Node.js 函数最长执行时间设为 120 秒。

此配置只设置境外区域，没有设置中国大陆区域。若 EdgeOne 项目选择包含中国大陆的加速区域，官方文档说明大陆函数区域未设置时使用默认广州。上线前须验证大陆函数到 Supabase Auth 和数据库的真实连通性与延迟；境外函数成功不能代表大陆路径可用。不要用未经验证的跨区代理或虚构区域配置绕过检查。

## 项目设置

将 eiepyc/ftdw1101 的 codex/edgeone-deploy 分支导入 EdgeOne Pages，根目录设为仓库根目录，框架预设选择 Next.js。检查控制台没有覆盖 edgeone.json 中的安装、构建和输出设置；不要启用静态导出。Next.js standalone 输出仅供 Docker 使用，EdgeOne 构建会单独省略该输出。

构建使用 Node.js 24.5.0，应用依赖声明支持 Node.js 20.19 及以上的 20.x、22.11 及以上的 22.x 和 24.x。EdgeOne Cloud Functions 文档说明默认运行时为 Node.js 20.x，但没有在项目配置中指定实际补丁版本。Node.js 官方已将 20.x 标记为停止维护；本仓库的 Node 20 检查只验证兼容性，不构成长期生产版本建议。部署前须从平台运行信息确认具体运行时及安全维护/升级安排；若平台提供受支持的 LTS 运行时，应优先使用该版本。本地 Node 20 验证不能替代平台运行时核对。

## 环境变量

在 EdgeOne 项目的服务端环境配置中填写以下变量。预览和生产使用不同的 Supabase 测试与生产项目，以及不同的密钥：

| 变量 | 设置 |
| --- | --- |
| APP_ORIGIN | 当前环境浏览器访问的规范 origin，例如 https://slots.example.com，不带路径或尾斜线 |
| APP_PROXY_MODE | 仅在确认下文的 EdgeOne 来源 IP 检查通过后设为 edgeone；否则设为 none |
| SUPABASE_URL | 当前环境 Supabase 项目 HTTPS URL |
| SUPABASE_SERVICE_ROLE_KEY | 当前环境服务端 service role 密钥，作为平台密钥保存 |
| SESSION_HASH_SECRET | 独立随机值，至少 32 字节 |
| DEVICE_SIGNING_SECRET | 独立随机值，至少 32 字节 |
| DEVICE_HASH_SECRET | 独立随机值，至少 32 字节 |
| RATE_LIMIT_HMAC_SECRET | 独立随机值，至少 32 字节 |

四个应用秘密不可复用。不要创建这些变量的 NEXT_PUBLIC_ 副本，不要把密钥写入 edgeone.json、构建参数、GitHub 源码、浏览器或日志。EdgeOne 部署不需要 Docker 的 PUBLIC_DOMAIN。

## 来源 IP 与限流

本地代理模式为 none。Docker Compose 显式使用 caddy，只读取 Caddy 覆盖的单个合法 X-Real-IP；未配置新变量的旧部署仍可用 TRUST_PROXY=true 选择该兼容模式。设置了 APP_PROXY_MODE 时，它优先于旧开关。

edgeone 模式只读取一个合法的 EO-Connecting-IP IPv4 或 IPv6 地址。它不读取 X-Forwarded-For 或 X-Real-IP。缺失、非法或逗号分隔的多个地址会落入原共享限流桶，仍保持限流。应用没有返回客户端 IP 的调试路由。

启用 APP_PROXY_MODE=edgeone 前，必须在 EdgeOne 预览环境从默认域名和自定义域名分别确认平台覆盖客户端提交的 EO-Connecting-IP，并确认伪造 X-Forwarded-For/X-Real-IP 不会影响来源限流。仓库单元测试只用合成请求验证应用的解析规则，不证明平台覆盖行为。若平台日志或支持渠道无法证明所有入口都覆盖该头，保持 none，不要把未经验证的来源头加入信任列表。

## 动态响应与 CSP 检查

Next.js Proxy 为动态页面和 API 注入每次请求生成的 CSP nonce，并发送 private, no-store。EdgeOne 预览验收时检查页面 HTML 中 nonce 与响应 CSP 一致且刷新后变化；确认动态页面、登录状态和 API 响应没有被共享缓存。保留 Next.js 的 /_next/static 静态资源处理。若平台响应覆盖了安全头、缓存策略或 Cookie，先修正平台规则，再考虑上线。

## 发布前验收

先部署隔离的预览环境，按顺序确认：

1. 构建日志显示 Next.js 16.3.6 构建成功，产物为 .next，没有静态导出或 standalone 目录要求。
2. 平台 Cloud Functions 运行时至少为 Node.js 20.19；EdgeOne 文档给出的默认大版本是 Node.js 20.x，本仓库尚未连接真实项目验证具体补丁版本或平台的安全维护安排。Node 20 为停止维护版本，确认平台升级路径。
3. 使用测试 Supabase 项目验证公开注册、登录、提交、登出和管理员操作；完成迁移并通过实际托管 Supabase Auth 注册限流检查。
4. 确认默认域名与自定义域名的规范 origin、TLS、Cookie、CSP nonce 和动态缓存行为。
5. 在两个域名入口完成上文的 EO-Connecting-IP 覆盖检查后，才将 APP_PROXY_MODE 从 none 改成 edgeone；再次验证合法来源和伪造备用头的限流行为。

上线前还要确认 EdgeOne 项目区域、请求体与函数包大小限制及当前套餐。仓库没有连接 EdgeOne 或 Supabase 生产账号；此配置和本地验证不能代表平台构建、真实 Auth 联调、DNS/TLS 或生产发布已经完成。
