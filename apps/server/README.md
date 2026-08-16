# Folo 自托管后端（阶段一最小闭环）

这个服务是 FOLO API 的自有兼容门面。当前版本不访问 FOLO 官方后端，PostgreSQL 是 Feed、
Subscription、Entry、阅读状态、收藏和用户设置的权威存储；客户端 SQLite 仍只是可重建缓存。

## 本地启动

需要 Node.js 22、pnpm 10 和 Docker：

```bash
cp apps/server/.env.example apps/server/.env
pnpm server:db:up
pnpm server:migrate
pnpm dev:self-hosted
```

`pnpm dev:self-hosted` 会同时启动 API（`http://localhost:3000`）和 Desktop Web renderer
（`http://localhost:2233`），并把前端 API 地址切到本地服务。首次使用时通过邮箱和密码注册本地账号。

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
- `FEED_POLL_INTERVAL_MS`：已订阅 Feed 的刷新周期，默认 15 分钟。

默认拒绝回环、内网、link-local 等私有地址，以降低 RSS URL 造成 SSRF 的风险。只有明确需要订阅
局域网 Feed 时才设置 `ALLOW_PRIVATE_FEEDS=true`；不要在不可信用户可注册的公网实例上开启。

## 已实现闭环

- Better Auth 邮箱密码注册、登录、会话和账号基本设置。
- 标准 RSS 2.0 / Atom 解析，稳定 Feed/Entry ID、重复导入幂等。
- URL 预览、订阅、编辑、批量编辑、退订、手动刷新和定时轮询。
- 时间线、Entry 详情、正文 NDJSON 流和 RSS 正文的 Readability 回退。
- 已读、未读、全部已读、未读计数和收藏。
- 基础 Settings、Status Configs、能力发现和未实现能力的固定 `501` 响应。
- PostgreSQL migration、真实数据库持久化集成测试和 URL 获取安全边界测试。

阶段一最小闭环暂不包括 Category/List 实体、OPML 导入导出、Profile/Avatar、网页正文抽取、
官方 RSSHub/Trending、AI、Billing 或 MCP。前端会根据能力清单隐藏已知不可用的发现入口。

## 验证

```bash
pnpm --filter @follow/server test
pnpm server:db:up
pnpm server:test:postgres
pnpm contracts:check
```

PostgreSQL 集成测试会真实执行 Better Auth 和 Drizzle migrations，跨服务实例重新连接后检查订阅
仍然存在。普通 `pnpm --filter @follow/server test` 在没有 `TEST_DATABASE_URL` 时会跳过该测试。
