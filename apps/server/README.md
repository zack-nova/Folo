# Folo 自托管后端（阶段四：长期运行稳定化）

这个服务是 FOLO API 的自有兼容门面。当前版本不访问 FOLO 官方后端，PostgreSQL 是 Feed、
Subscription、List、Entry、阅读状态、收藏、正文缓存、AI 配置、处理作业和评估结果的权威存储；客户端
SQLite 仍只是可重建缓存。

## 本地启动

需要 Node.js 22、pnpm 10 和 Docker：

```bash
cp apps/server/.env.example apps/server/.env
pnpm server:db:up
pnpm server:migrate
pnpm dev:self-hosted
```

`pnpm dev:self-hosted` 会同时启动 API（`http://localhost:3000`）和 Desktop Web renderer
（`http://localhost:2233`），并把前端 API 地址切到本地服务。首次使用时通过邮箱和密码注册本地账号；
默认首个账号成为实例所有者，随后注册入口关闭。

只启动后端：

```bash
pnpm --filter @follow/server dev
```

停止开发数据库容器（保留 named volume 中的数据）：

```bash
pnpm server:db:down
```

## 配置

所有配置由环境变量提供，完整样例见 [`.env.example`](./.env.example)。生产部署至少需要替换：

- `DATABASE_URL`：PostgreSQL 连接串。
- `BETTER_AUTH_SECRET`：至少 32 字符的随机密钥，不能使用仓库中的开发值。
- `SERVER_URL`：浏览器实际访问的 API 地址。
- `CLIENT_ORIGINS`：允许携带登录 Cookie 的前端 origin，多个值用逗号分隔。
- `UPLOADS_DIRECTORY`：头像文件目录；生产环境应放在持久卷中并单独备份。
- `METRICS_TOKEN`：生产环境必填；Prometheus 请求 `/metrics` 时使用 Bearer Token。
- `TRUST_PROXY_HOPS`：反向代理跳数，生产 Compose 默认拓扑建议设为 `1`；不要无条件信任所有代理头。
- `API_RATE_LIMIT_MAX`、`AUTH_RATE_LIMIT_MAX`：按客户端 IP 的每分钟 API 和认证写请求上限。
- `ALLOW_PUBLIC_REGISTRATION`：默认 `false`；只应在明确需要多人注册时临时开启。
- `FEED_POLL_INTERVAL_MS`：已订阅 Feed 的刷新周期，默认 15 分钟。
- `FEED_POLL_CONCURRENCY`：轮询并发数，默认 4，最大 32。
- `FEED_RETRY_BASE_DELAY_MS`：单个 Feed 获取失败后的指数退避基数，默认 1 分钟，最长 24 小时。
- `FEED_SUPPLIER_URL`、`FEED_SUPPLIER_TOKEN`：可选阶段 5A 内部供给服务地址和独立 Bearer Token；必须成对配置。
- `AI_API_KEY`、`AI_PROVIDER_BASE_URL`、`AI_PROVIDER_MODEL`：可选的环境托管 Provider。也可以登录后通过
  `/api/extensions/ai/provider` 保存 BYOK 配置；数据库只保存 AES-256-GCM 密文和末四位提示。
- `AI_ENCRYPTION_SECRET`：用于加密数据库 BYOK，默认复用 `BETTER_AUTH_SECRET`。生产环境建议独立设置且必须
  纳入密钥备份；更换后旧密文无法解密。
- `PROCESSING_MAX_ATTEMPTS`、`PROCESSING_RETRY_BASE_DELAY_MS`：后台处理的最大自动尝试次数和指数退避基数。

默认拒绝回环、内网、link-local 等私有地址，以降低 RSS URL 造成 SSRF 的风险。只有明确需要订阅
局域网 Feed 时才设置 `ALLOW_PRIVATE_FEEDS=true`；不要在不可信用户可注册的公网实例上开启。
服务同时拒绝不受信任 Origin 或 `Sec-Fetch-Site: cross-site` 的写请求，并为响应添加标准安全头。生产配置
强制 HTTPS、独立的认证/AI 加密密钥及指标令牌；只有明确接受风险时才可设置
`ALLOW_INSECURE_HTTP=true`。日志会脱敏 Cookie、Authorization、API Key 请求头和 Set-Cookie。

生产 Compose 默认只监听 `127.0.0.1:3000`，并以只读根文件系统、无 Linux capabilities、
`no-new-privileges`、进程数限制和滚动日志启动 API。请在宿主机上使用 Caddy、Nginx 或同类反向代理终止
TLS，只把可信公网域名转发到 `127.0.0.1:3000`。若代理链不是一跳，必须相应调整
`TRUST_PROXY_HOPS`；不要把 API 端口改为 `0.0.0.0` 后直接暴露公网。

Prometheus 抓取配置需要携带认证：

```yaml
authorization:
  type: Bearer
  credentials: "${METRICS_TOKEN}"
```

## 生产镜像依赖锁

生产镜像不使用 monorepo 的共享 hoisted 依赖闭包，而使用
[`pnpm-lock.production.yaml`](./pnpm-lock.production.yaml) 安装服务端运行时依赖。专用工作区关闭 optional peer
自动安装，避免 Better Auth、Drizzle 将仓库中已经存在但服务端不使用的 Next、Vitest、Expo SQLite 和
React Native 带入镜像。构建阶段使用 pnpm，最终运行层不包含 pnpm、Corepack 或 package store。

修改 `apps/server/package.json`、`packages/readability/package.json` 或
`packages/compat-contracts/package.json` 的运行依赖后，重新生成锁并构建镜像：

```bash
pnpm --filter @follow/server prod:lock:update
docker build -f apps/server/Dockerfile -t folo-server:local .
```

不要手工编辑生产锁。Docker 使用 frozen install，依赖清单和锁不同步时会停止构建。

## 已实现闭环

- Better Auth 邮箱密码注册、登录、会话和账号基本设置。
- 标准 RSS 2.0 / Atom 解析，稳定 Feed/Entry ID、重复导入幂等。
- URL 预览、订阅、编辑、批量编辑、退订、手动刷新和定时轮询。
- Category、List 及 List Feed 成员管理。
- OPML 安全解析、预览、选择性导入、冲突报告和 OPML/JSON 导出。
- 单实例所有者、资料字段、头像内容校验、哈希存储和本地读取。
- 时间线、Entry 详情、正文 NDJSON 流、网页 Readability 抽取、缓存及 RSS 正文回退。
- 已读、未读、全部已读、未读计数和收藏。
- 基础 Settings、Status Configs、能力发现和未实现能力的固定 `501` 响应。
- PostgreSQL migration、隔离备份恢复演练、真实数据库持久化和浏览器端到端测试。
- OpenAI-compatible BYOK 或环境 Provider；服务端不向客户端回传完整 Key。
- Follow 原生摘要和 NDJSON 批量翻译接口，按 Entry、语言和目标持久化缓存。
- 版本化用户画像和 Taxonomy 快照；内容哈希避免相同配置重复创建版本。
- `queued → running → succeeded/failed/superseded` Processing Job、Attempt、指数退避和人工重试。
- 不可变 Entry Evaluation、当前指针、强制重评、历史回滚和失败保护。
- 批量投影、批量重评预览/提交，以及 Action `evaluate` 自动处理新导入和定时刷新 Entry。
- 三维评分使用后端版本化公式：`importance × 0.3 + timeliness × 0.2 + relevance × 0.5`。
- 启动及每日清理：成功 Attempt 30 天、失败 Attempt 90 天、诊断元数据 7 天；评估至少保留最近 10 条且
  至少保留 180 天，当前指针引用永不清理。
- ETag/Last-Modified 条件获取、每源指数退避、最近获取诊断和 30 天/每源 500 条保留上限。
- 数据库 schema 向前版本护栏、带 SHA-256 的备份、隔离恢复演练和终态 Processing Job 清理。
- `/ready`、Prometheus `/metrics`、所有者运行状态与结构化告警，以及生产 Compose/回滚手册。
- 能力门控的所有者运维前端：运行概览、Feed/AI 失败列表、获取诊断和人工重试。
- 批量 Entry 投影查询和 10,000 Entry 容量基准，避免时间线逐 Entry 读取后端投影。
- 独立 feed-supplier、自建 RSSHub 的 `rsshub://` 预览/订阅/刷新闭环，以及 provider 健康状态和告警。

FOLO 官方 RSSHub/Trending、AI Chat、Billing、MCP、多人权限和外部通知投递仍未实现；摘要、翻译和
逐条评估全部由本地后端调用所有者配置的 Provider，不访问 Folo 官方后端。

阶段二完整接口和状态语义见
[`stage-2-ai-processing-backend.md`](../../docs/feeds-agent-integration/stage-2-ai-processing-backend.md)。
对应的阶段三 Folo 前端融合与能力门控见
[`stage-3-frontend-fusion.md`](../../docs/feeds-agent-integration/stage-3-frontend-fusion.md)。
阶段四获取、运维、备份与回滚契约见
[`stage-4-runtime-stability.md`](../../docs/feeds-agent-integration/stage-4-runtime-stability.md)。
阶段 4.2 生产验证、安全基线和运维管理前端见
[`stage-4-2-production-operations.md`](../../docs/feeds-agent-integration/stage-4-2-production-operations.md)。
阶段 5A 自主数据源、自建 RSSHub 和供给端契约见
[`stage-5a-autonomous-sources.md`](../../docs/feeds-agent-integration/stage-5a-autonomous-sources.md)。

## 备份与恢复演练

数据库备份使用 PostgreSQL custom archive，拒绝覆盖已有文件，并在落盘前执行 archive 校验和
SHA-256 checksum：

```bash
pnpm server:backup backups/folo-$(date +%F).dump
pnpm server:restore:drill backups/folo-2026-08-18.dump
```

恢复演练只操作唯一命名的临时库，对比主库与恢复库的阶段一、阶段二关键权威表行数，随后自动删除，
不改动 `folo` 主库。
头像不在 PostgreSQL 中；必须同时备份 `UPLOADS_DIRECTORY` 所在持久卷。生产恢复应先恢复到新数据库并完成
演练，再切换 `DATABASE_URL`，不要直接覆盖运行中的主库。

## 验证

```bash
pnpm --filter @follow/server test
pnpm --filter @follow/server prod:lock:check
pnpm --filter @follow/server bench
pnpm server:db:up
pnpm server:test:postgres
pnpm server:e2e:web
pnpm contracts:check
```

PostgreSQL 集成测试会真实执行 Better Auth 和 Drizzle migrations，跨服务实例重新连接后检查订阅
仍然存在。普通 `pnpm --filter @follow/server test` 在没有 `TEST_DATABASE_URL` 时会跳过该测试。
