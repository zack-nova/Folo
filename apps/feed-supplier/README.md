# Folo Feed Supplier

阶段 5A 的独立数据源供给服务。它把 `rsshub://` 路由转换为自建 RSSHub 的标准 Feed，并把
`pagechange://` 页面来源的确认变化物化为新 GUID RSS Entry。5A.2–5A.4 使用独立 PostgreSQL 保存路由、
自有路由目录、密文凭据、页面观测状态、不可变事件和 HMAC 哈希链审计；数据库和密钥都不进入 Folo 核心。

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
GET    /v1/admin/catalog/routes
POST   /v1/admin/catalog/routes
GET    /v1/admin/catalog/routes/:routeId
PATCH  /v1/admin/catalog/routes/:routeId
DELETE /v1/admin/catalog/routes/:routeId
POST   /v1/admin/catalog/routes/:routeId/test
GET    /v1/admin/page-sources
POST   /v1/admin/page-sources
GET    /v1/admin/page-sources/:sourceId
PATCH  /v1/admin/page-sources/:sourceId
DELETE /v1/admin/page-sources/:sourceId
POST   /v1/admin/page-sources/:sourceId/test
POST   /v1/admin/page-sources/:sourceId/check
GET    /v1/admin/page-sources/:sourceId/events
GET    /v1/admin/audit
GET    /v1/admin/audit/verify
```

凭据值只允许写入，不允许读回。路由通过 `secretQueryBindings` 将上游查询参数绑定到凭据 ID，诊断 URL、
响应和审计都不会包含明文。RSSHub 的基础 `ACCESS_KEY` 仍是部署密钥，不属于业务凭据库。

创建一个自有目录路由：

```bash
curl -fsS -H "Authorization: Bearer $FEED_SUPPLIER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"key":"repository-releases","title":"Repository releases","category":"Development","routePathTemplate":"/github/releases/:owner/:repository","parameters":[{"key":"owner","label":"Owner","location":"path","required":true,"type":"string"},{"key":"repository","label":"Repository","location":"path","required":true,"type":"string"}]}' \
  http://127.0.0.1:3001/v1/admin/catalog/routes
```

启用目录通过内部令牌提供 `GET /v1/catalog/routes` 以及按 route ID 的 `render`、`test`。这些接口只返回公开
schema、逻辑地址和脱敏诊断；Folo 核心再以实例 Owner 会话代理给“设置 → 数据源”页面。目录初始为空，
不会访问 FOLO 官方目录，也不会向浏览器返回内部令牌、管理令牌或凭据绑定。

创建一个默认不定时抓取的页面来源，并执行第一次真实观测：

```bash
curl -fsS -H "Authorization: Bearer $FEED_SUPPLIER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"Example status","targetURL":"https://example.com/status","contentSelector":"main"}' \
  http://127.0.0.1:3001/v1/admin/page-sources

curl -fsS -X POST -H "Authorization: Bearer $FEED_SUPPLIER_ADMIN_TOKEN" \
  http://127.0.0.1:3001/v1/admin/page-sources/<source-id>/check
```

第一次非空观测会立即发布消息。后续不同指纹默认等待五分钟再次确认。要启用定时检测，把来源更新为
`{"enabled":true,"intervalMinutes":360}`。创建响应中的 `feedURL` 可以直接粘贴进 Folo 发现输入框订阅；
页面 Feed 只读取已物化事件，不会在核心轮询时访问目标网页。

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
