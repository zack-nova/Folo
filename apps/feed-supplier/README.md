# Folo Feed Supplier

阶段 5A 的独立数据源供给服务。它把 `rsshub://` 路由转换为自建 RSSHub 的标准 Feed，并把
`pagechange://` 页面来源的确认变化物化为新 GUID RSS Entry。5A.2–5A.4 使用独立 PostgreSQL 保存路由、
自有路由目录、密文凭据、页面观测状态、不可变事件和 HMAC 哈希链审计；数据库和密钥都不进入 Folo 核心。

本地通常先在仓库根目录运行完整 sources 预检，再启动完整自托管栈：

```bash
pnpm preflight:self-hosted:sources
pnpm dev:self-hosted:sources
```

预检会在启动前确认 Docker daemon、Compose、buildx、Docker credential helper、仓库钉住的 pnpm 版本和
本地服务端口状态。`feed-supplier` 的开发镜像依赖 Docker BuildKit；如果 `docker buildx version`
不可用，Compose 会回退到普通 builder，并在 Dockerfile 的 cache mount 步骤失败。预检只诊断，不会自动
安装 buildx 或改写 Docker 配置。

单独开发时：

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

## 生产规模化

生产环境必须配置 Redis。`feed-supplier` 用 Redis DB 1 保存可重建的 RSSHub 响应缓存、每路由固定窗口
计数器，以及全局/每路由并发租约；RSSHub 自身使用 DB 0。两个服务共享 Redis 实例但不共享 key 空间。
缓存 key、限流 key 和租约 key 都只包含逻辑地址或策略标识的 SHA-256，不保存逻辑 URL、RSSHub
`ACCESS_KEY` 或路由秘密参数。Redis 使用 `noeviction`，内存耗尽会失败关闭，不能淘汰活动租约后绕过容量
保护。

默认策略：

- 成功的 2xx RSSHub 响应缓存 60 秒，缓存正文仍受 `RSSHUB_FETCH_MAX_BYTES` 限制。
- 同一进程内，相同逻辑地址及相同条件请求头的并发 miss 合并为一次上游请求。
- 每个精确路由实例或目录路由每 60 秒最多 60 次上游尝试；未登记兼容路由按逻辑地址隔离。
- 全局最多 16 个、同一路由最多 4 个并发上游请求；连接测试同样受保护但不读取响应缓存。
- 缓存命中不消耗上游限流和并发配额。Redis 不可用时供给端 readiness 失败并拒绝新 RSSHub 请求，
  不静默降级为每实例内存状态。

这些值可分别通过 `RSSHUB_CACHE_TTL_SECONDS`、`RSSHUB_ROUTE_RATE_LIMIT_MAX`、
`RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS`、`RSSHUB_GLOBAL_CONCURRENCY` 和
`RSSHUB_ROUTE_CONCURRENCY` 调整。普通 HTTP/HTTPS RSS 仍由核心抓取；`pagechange://` 调度不经过这套
RSSHub 配额，因此不会影响常规 RSS 推送逻辑。

`GET /v1/providers` 暴露缓存状态和进程内累计计数；核心 `/metrics` 转换为 Prometheus 指标，桌面端
“设置 → 运维”显示同一份摘要。响应头 `x-folo-cache: HIT|MISS` 和可选的
`x-folo-coalesced: true` 可用于单次请求诊断。

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
