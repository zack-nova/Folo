# Folo 自托管后端（阶段二：自主 AI 处理）

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
- `ALLOW_PUBLIC_REGISTRATION`：默认 `false`；只应在明确需要多人注册时临时开启。
- `FEED_POLL_INTERVAL_MS`：已订阅 Feed 的刷新周期，默认 15 分钟。
- `AI_API_KEY`、`AI_PROVIDER_BASE_URL`、`AI_PROVIDER_MODEL`：可选的环境托管 Provider。也可以登录后通过
  `/api/extensions/ai/provider` 保存 BYOK 配置；数据库只保存 AES-256-GCM 密文和末四位提示。
- `AI_ENCRYPTION_SECRET`：用于加密数据库 BYOK，默认复用 `BETTER_AUTH_SECRET`。生产环境建议独立设置且必须
  纳入密钥备份；更换后旧密文无法解密。
- `PROCESSING_MAX_ATTEMPTS`、`PROCESSING_RETRY_BASE_DELAY_MS`：后台处理的最大自动尝试次数和指数退避基数。

默认拒绝回环、内网、link-local 等私有地址，以降低 RSS URL 造成 SSRF 的风险。只有明确需要订阅
局域网 Feed 时才设置 `ALLOW_PRIVATE_FEEDS=true`；不要在不可信用户可注册的公网实例上开启。

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

官方 RSSHub/Trending、AI Chat、Billing、MCP、多人权限和生产级可观测性仍未实现；阶段二的摘要、翻译和
逐条评估全部由本地后端调用所有者配置的 Provider，不访问 Folo 官方后端。

阶段二完整接口和状态语义见
[`stage-2-ai-processing-backend.md`](../../docs/feeds-agent-integration/stage-2-ai-processing-backend.md)。
对应的阶段三 Folo 前端融合与能力门控见
[`stage-3-frontend-fusion.md`](../../docs/feeds-agent-integration/stage-3-frontend-fusion.md)。

## 备份与恢复演练

数据库备份使用 PostgreSQL custom archive，拒绝覆盖已有文件，并在落盘前执行 archive 校验：

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
pnpm server:db:up
pnpm server:test:postgres
pnpm server:e2e:web
pnpm contracts:check
```

PostgreSQL 集成测试会真实执行 Better Auth 和 Drizzle migrations，跨服务实例重新连接后检查订阅
仍然存在。普通 `pnpm --filter @follow/server test` 在没有 `TEST_DATABASE_URL` 时会跳过该测试。
