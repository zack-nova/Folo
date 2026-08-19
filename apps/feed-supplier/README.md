# Folo Feed Supplier

阶段 5A 的独立数据源供给服务。它把 `rsshub://` 逻辑地址转换为自建 RSSHub 的标准 RSS/Atom，并通过
内部 Bearer Token 只向 Folo 主后端开放。5A.2 使用独立 PostgreSQL 保存路由实例、AES-256-GCM 密文和
HMAC 哈希链审计；数据库和密钥都不进入 Folo 核心。

本地通常直接运行仓库根目录的 `pnpm dev:self-hosted:sources`。单独开发时：

```bash
cp apps/feed-supplier/.env.example apps/feed-supplier/.env
pnpm --filter @follow/feed-supplier dev
```

`ROUTE_REGISTRY_MODE=permissive` 兼容未登记的 5A.1 地址；完成既有来源迁移后改为 `managed_only`，只允许
数据库中的启用路由。管理 API 使用与核心抓取令牌不同的 `ADMIN_TOKEN`：

```text
GET    /v1/admin/credentials
POST   /v1/admin/credentials
PATCH  /v1/admin/credentials/:credentialId
DELETE /v1/admin/credentials/:credentialId
POST   /v1/admin/credentials/rotate
GET    /v1/admin/routes
POST   /v1/admin/routes
PATCH  /v1/admin/routes/:routeId
DELETE /v1/admin/routes/:routeId
POST   /v1/admin/routes/:routeId/test
GET    /v1/admin/audit
GET    /v1/admin/audit/verify
```

凭据值只允许写入，不允许读回。路由通过 `secretQueryBindings` 将上游查询参数绑定到凭据 ID，诊断 URL、
响应和审计都不会包含明文。RSSHub 的基础 `ACCESS_KEY` 仍是部署密钥，不属于业务凭据库。

生产需分别复制主 API 与 sources 环境文件：

```bash
cp apps/server/.env.production.example apps/server/.env.production
cp apps/feed-supplier/.env.production.example apps/feed-supplier/.env.production

docker compose \
  --env-file apps/server/.env.production \
  --env-file apps/feed-supplier/.env.production \
  -f apps/server/compose.production.yaml --profile sources up -d --wait
```

备份与恢复演练：

```bash
pnpm sources:backup ./feed-supplier.dump
pnpm sources:restore:drill ./feed-supplier.dump
```

生产备份时同时设置 `FEED_SUPPLIER_COMPOSE_FILE`、`FEED_SUPPLIER_MAIN_ENV_FILE` 和
`FEED_SUPPLIER_SOURCES_ENV_FILE`，脚本会用相同的双环境文件解析生产 Compose。

生产必须设置彼此独立的内部、管理、数据库、凭据加密、审计和 RSSHub 密钥。阶段 5A 完整契约见
[`stage-5a-autonomous-sources.md`](../../docs/feeds-agent-integration/stage-5a-autonomous-sources.md)。
