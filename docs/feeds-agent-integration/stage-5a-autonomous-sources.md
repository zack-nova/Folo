# 阶段 5A：自主数据源扩展

## 冻结结论

阶段五拆为两个互不依赖的轨道：

- **阶段 5A**：只连接完全自主管理的数据源和凭据，不访问 FOLO 官方后端。
- **阶段 5B**：可选的 FOLO 官方能力适配，必须最后单独授权和启用。

`sources.rsshub_self_hosted` 是阶段 5A 的本地能力；`rsshub.hosted` 仍表示 FOLO 官方托管接口。两者不能
复用 capability，也不能因配置了自建 RSSHub 而启用 `discover.rsshub`、`rsshub.*` 等官方 SDK 调用。

## 5A.1 自建 RSSHub 最小闭环

首个切片支持以下链路：

```text
Folo 前端 rsshub:// 路由
  -> 自有 API / FeedImporter
      -> RoutingFeedFetcher
          -> 独立 feed-supplier（内部 Bearer）
              -> 自建 RSSHub（ACCESS_KEY）
                  -> 标准 RSS/Atom
      -> 自有 Feed / Entry / Subscription / AI 流水线
```

边界规则：

1. 用户和前端只保存 `rsshub://namespace/route?...` 逻辑地址。
2. 逻辑地址是 Feed 的稳定身份；RSSHub 容器、域名或内部端口变化不改变 Feed ID。
3. 主后端不知道 RSSHub `ACCESS_KEY`，只持有 `FEED_SUPPLIER_TOKEN`。
4. `feed-supplier` 拒绝用户在逻辑地址中传入 `key`，并在服务端追加环境托管的访问密钥。
5. 供给端只向核心返回 RSS/Atom、条件请求元数据和已去除密钥的响应 URL。
6. HTTP/HTTPS 普通 Feed 仍走现有 SSRF 防护抓取器；Readability 不经过供给端。
7. 供给端、RSSHub 与核心可独立重启；供给端不可用只让对应 Feed 进入原有退避，不影响已导入内容和 AI。

内部供给协议：

- `GET /health`：供给进程存活。
- `GET /ready`：供给进程可以访问配置的 RSSHub。
- `GET /v1/providers`：Bearer 认证的 provider 健康清单。
- `GET /v1/feeds/rsshub?url=<rsshub-url>`：Bearer 认证的 Feed 物化端点，支持
  `If-None-Match` 与 `If-Modified-Since`。

本切片使用 RSSHub 官方支持的 `ACCESS_KEY` 环境配置，并遵循官方路由的路径参数和通用查询参数约定。
部署时应将 RSSHub 镜像通过 `RSSHUB_IMAGE` 固定到经过验证的 tag 或 digest；不要把浮动的 `latest`
直接用于生产升级。参考 [RSSHub 配置源码](https://github.com/DIYgod/RSSHub/blob/master/lib/config.ts) 和
[RSSHub 官方仓库](https://github.com/DIYgod/RSSHub)。

## 5A.2 数据源配置持久化

供给端使用独立 PostgreSQL 和独立数据卷，不复用主后端的连接、schema、账号或网络。数据库保存：

- `source_credentials`：AES-256-GCM 密文、12 字节随机 IV、认证标签和加密 key ID；API 永不返回明文。
- `source_route_instances`：稳定 `rsshub://` 身份、启用状态和秘密查询参数到凭据 ID 的绑定。
- `source_audit_events`：凭据和路由变更事件；数据库触发器拒绝更新/删除，HMAC-SHA256 前向哈希链检测篡改。
- `feed_supplier_schema_migrations`：供给端自己的 schema 版本。

抓取使用的 `INTERNAL_TOKEN` 和管理使用的 `ADMIN_TOKEN` 必须不同。核心只能访问 Feed 与 provider 接口，
不能调用 `/v1/admin/*`。路由绑定中的凭据只在供给端内存中解密并注入上游查询；诊断 URL 会同时移除
RSSHub `key` 和所有秘密绑定参数。

注册模式：

- `permissive`：已登记路由使用持久化配置，未登记路由保持 5A.1 兼容行为。
- `managed_only`：只允许已登记且启用的路由，适合迁移完成后的生产环境。

加密密钥轮换采用 keyring：配置新 active key，同时把旧 key 放入
`CREDENTIAL_DECRYPTION_KEYS_JSON`，重启后调用 `POST /v1/admin/credentials/rotate`，确认所有活动凭据的
`keyId` 已更新后再移除旧 key。`AUDIT_HMAC_KEY` 独立轮换需要新的审计链迁移方案，当前不得直接替换。

## 能力发现与运维

只有主后端实际配置供给端时，`GET /api/extensions/capabilities` 才宣告：

```json
[
  { "id": "sources.rsshub_self_hosted", "provider": "local" },
  { "id": "sources.page_change", "provider": "local" },
  { "id": "sources.route_catalog", "provider": "local" }
]
```

未配置时服务仍报告阶段四能力，前端隐藏 `rsshub://`、`pagechange://` 和自有目录入口。配置后报告阶段五
能力，但 `rsshub.hosted` 继续位于 `unavailable`。

所有者运维状态新增 `source_providers`，Prometheus 新增：

```text
folo_source_provider_ready{provider="rsshub"} 0|1
folo_source_provider_ready{provider="page_change"} 0|1
folo_page_change_sources_enabled <count>
folo_page_change_sources_due <count>
```

供给端不可用会生成 `source_provider_unavailable` 告警。状态和日志不得返回内部 Bearer Token 或
RSSHub `ACCESS_KEY`。

## 5A.3 页面变化源

页面来源使用稳定的 `pagechange://<source-uuid>` 逻辑地址。核心的 `RoutingFeedFetcher` 只把这个协议交给
`feed-supplier`，普通 HTTP/HTTPS RSS 和 `rsshub://` 的判断、抓取、轮询、退避与解析没有改变。

```text
feed-supplier 页面 worker
  -> 公网 HTTP/HTTPS 页面（逐跳 SSRF 校验）
  -> CSS 区域提取、忽略选择器、可见文本规范化
  -> SHA-256 内容指纹
  -> 空基线首次发布 / 后续候选确认
  -> page_change_events 不可变事件
  -> /v1/feeds/page-change 物化 RSS
  -> Folo FeedImporter / Entry / Action / 自主 AI
```

页面来源默认停用定时检测。启用来源并配置间隔后，供给端按来源调度；支持的间隔下限为 15 分钟，建议页面
默认使用 6 小时。worker 首期单进程串行处理每轮到期来源，失败按 15 分钟起步指数退避。页面 Feed 请求只读
数据库，不会同步抓网页，也不会占用普通 RSS 的网络连接。

变化状态机：

1. 基线初始为 `null`；空白抽取结果保持空基线且不发布消息。
2. 第一次非空观测立即写入一个新 GUID 事件并接受为基线。
3. 后续不同指纹保存为候选，默认设置五分钟确认时间。
4. 确认时仍为同一候选则发布新事件；恢复基线则丢弃；出现第三种内容则替换候选并重新计时。
5. 候选内容收到 HTTP `304` 表示仍然稳定，可以在确认时间到达后发布。
6. 页面事件与新基线在同一事务中提交；数据库触发器拒绝更新或删除事件。

内容抽取优先使用配置的 `contentSelector`；缺省使用 `main`、`article`、`[role=main]`，最后回退到
`body`。`ignoreSelectors` 用于移除时钟、广告等动态区域。默认去除 script/style/template、零宽字符与纯
空白差异，不使用相似度阈值，避免漏掉价格、版本号或状态的一字符变化。抽取正文上限默认 256 KiB，页面
响应上限默认 5 MiB。

管理 API 继续只接受独立 `ADMIN_TOKEN`：

```text
GET    /v1/admin/page-sources
POST   /v1/admin/page-sources
GET    /v1/admin/page-sources/:sourceId
PATCH  /v1/admin/page-sources/:sourceId
DELETE /v1/admin/page-sources/:sourceId
POST   /v1/admin/page-sources/:sourceId/test
POST   /v1/admin/page-sources/:sourceId/check
GET    /v1/admin/page-sources/:sourceId/events
```

`test` 是无状态抽取预览；`check` 执行真实观测并可能发布事件。创建接口返回 `feedURL`，应用所有者可以在
Folo 发现输入框粘贴该 `pagechange://` 地址完成普通 Feed 订阅。核心和浏览器都不会取得 `ADMIN_TOKEN`。

第一版只支持无需登录、服务端可直接访问的公开 HTML 或文本页面。不支持 JavaScript 浏览器渲染、Cookie
登录、截图比较、AI 语义去噪、邮件、Webhook 或系统通知；这些能力不得通过扩大核心 RSS 抓取器职责实现。

## 5A.4 自有路由目录与参数表单

路由目录是供给端自己的权威数据，不读取、缓存或代理 FOLO 官方目录。`source_catalog_routes` 保存稳定路由
key、展示元数据、RSSHub 路径模板、公开参数 schema、启用状态和秘密查询参数到凭据 ID 的绑定。目录初始
为空，由部署者通过独立 `ADMIN_TOKEN` 发布；仓库不内置可能随 RSSHub 版本漂移的路由预设。

支持的公开参数类型为 `string`、`integer`、`boolean` 和 `enum`，位置为 `path` 或 `query`。路径占位符必须
与必填 path 参数一一对应；整数支持上下界，枚举值由目录定义。渲染器拒绝未知参数、重复查询参数、秘密
参数冲突、越界值、不完整模板、点路径段和可能命中同一地址的歧义模板，并只生成经过 URL 编码的
`rsshub://` 逻辑地址。解析时仍按静态段数量和稳定 key 排序，避免异常并发写入导致路由选择随展示顺序变化。

管理接口继续只接受 `ADMIN_TOKEN`：

```text
GET    /v1/admin/catalog/routes
POST   /v1/admin/catalog/routes
GET    /v1/admin/catalog/routes/:routeId
PATCH  /v1/admin/catalog/routes/:routeId
DELETE /v1/admin/catalog/routes/:routeId
POST   /v1/admin/catalog/routes/:routeId/test
```

核心只持有 `FEED_SUPPLIER_TOKEN`，可访问以下内部只读/执行接口；它不能修改目录或读取凭据绑定：

```text
GET  /v1/catalog/routes
POST /v1/catalog/routes/:routeId/render
POST /v1/catalog/routes/:routeId/test
```

核心再以实例 Owner 会话保护 `/api/extensions/sources/catalog` 及其 `render`、`test` 子路由。桌面端只有在
`sources.route_catalog` 被宣告时显示“数据源”设置页，提供搜索、分类过滤、动态类型表单、连接测试，并把
生成的逻辑地址交给既有 `FeedForm` 完成预览和订阅。浏览器不接收内部或管理令牌，也不接收凭据 ID/值。
核心会对供给端目录响应执行严格 schema 校验并拒绝任何额外管理字段，避免内部协议漂移把凭据绑定透传到浏览器。

目录模板同时参与 `managed_only` 路由解析，因此由表单生成的地址不需要再创建一条路由实例；精确登记的
`source_route_instances` 仍具有优先级。普通 HTTP/HTTPS RSS、页面变化源和既有 `rsshub://` 实例链路保持
不变。目录增删改与连接测试写入现有 HMAC 前向哈希链审计，备份恢复演练把目录表列为权威表。

## 配置与启动

本地最小闭环：

```bash
pnpm dev:self-hosted:sources
```

主 API 环境文件只增加：

```dotenv
FEED_SUPPLIER_URL=http://feed-supplier:3001
FEED_SUPPLIER_TOKEN=<独立的 32+ 字符随机令牌>
```

供给端专用环境文件增加：

```dotenv
FEED_SUPPLIER_ADMIN_TOKEN=<独立管理令牌>
FEED_SUPPLIER_DATABASE_URL=<独立 PostgreSQL URL>
FEED_SUPPLIER_POSTGRES_PASSWORD=<独立数据库密码>
FEED_SUPPLIER_CREDENTIAL_ENCRYPTION_KEY=<base64 编码的 32 字节随机 key>
FEED_SUPPLIER_CREDENTIAL_ENCRYPTION_KEY_ID=primary-2026-08
FEED_SUPPLIER_AUDIT_HMAC_KEY=<另一个 base64 编码的 32 字节随机 key>
PAGE_FETCH_TIMEOUT_MS=15000
PAGE_FETCH_MAX_BYTES=5242880
PAGE_CONTENT_MAX_BYTES=262144
PAGE_SCHEDULER_POLL_INTERVAL_MS=60000
RSSHUB_ACCESS_KEY=<另一独立随机密钥>
RSSHUB_IMAGE=diygod/rsshub@sha256:<经过验证的镜像摘要>
```

供给端的数据库、管理、加密、审计和 RSSHub 密钥放在独立 sources 环境文件；API 环境文件只能包含
`FEED_SUPPLIER_URL` 和 `FEED_SUPPLIER_TOKEN`。启用 Compose profile：

```bash
docker compose --env-file apps/server/.env.production \
  --env-file apps/feed-supplier/.env.production \
  -f apps/server/compose.production.yaml --profile sources up -d --wait
```

认证/AI/指标、供给端内部认证、供给端管理、凭据加密、审计、供给数据库和 RSSHub 访问密钥必须相互独立。
数据库备份必须与当前 keyring 和审计 HMAC key 一起纳入加密备份，但不能放在同一个明文归档中。

## 5A 后续切片

5A.4 完成后按以下顺序继续：

1. **5A.5 生产规模化**：Redis 缓存、每路由限流、并发隔离和真实数据灰度。

阶段 5B 不属于上述切片。只有 5A 真实数据灰度稳定后，才评估是否需要 FOLO 官方发现或托管获取。

## 工作量判断

- 5A.1：约 3–5 人日，代码、契约、容器、运维可见性和自动测试组成一个最小闭环。
- 5A.2：独立配置库、凭据生命周期、审计、备份恢复已完成。
- 5A.3：页面来源持久化、空基线首次发布、确认去抖、物化 Feed、调度隔离和自动测试已完成。
- 5A.4：自有目录持久化、严格参数 schema、连接测试、Owner 代理和前端表单已完成。
- 5A.5：约 1–2 周工程化，再加真实数据灰度观察时间。

最大风险不是 RSS 代理本身，而是站点凭据安全、反爬变化、调度公平性和页面变化去重。真实数据灰度按既定
决定延后，不作为 5A.1 自动化验收的一部分。

## 5A.1 验收标准

- 普通 HTTP/HTTPS Feed 行为和 SSRF 防护不回退。
- `rsshub://` 预览、订阅、刷新、304、失败退避和诊断走 `feed_supplier`。
- 逻辑 URL 跨 RSSHub 实例变化保持 Feed/Entry 身份稳定。
- 前端只在本地 capability 被宣告时接受 `rsshub://`。
- RSSHub 密钥不会出现在浏览器、主后端配置、诊断 URL 或日志中。
- 供给端关闭时既有 Entry 可读，其他 Feed 和 AI 处理继续工作。
- 类型检查、格式、lint、单测、契约测试和生产依赖锁全部通过。

## 5A.2 验收标准

- 供给端数据库使用独立账号、数据卷和网络，核心不能直接连接。
- 凭据明文不出现在读取 API、审计、诊断 URL 或数据库字段中；篡改密文会认证失败。
- 路由实例跨供给端重启保持稳定，禁用路由立即停止抓取，启用路由才能绑定活动凭据。
- 内部抓取令牌不能访问管理 API，管理令牌不交给核心。
- 审计表拒绝更新和删除，完整哈希链可以通过管理端点验证。
- 加密 keyring 可以读取旧 key，并在事务中批量重加密到 active key。
- 独立数据库备份带校验和，恢复演练核对权威表行数。

## 5A.3 验收标准

- 第一次非空页面观测产生一个新 GUID Entry；空内容不建立基线或产生消息。
- 后续变化必须经过候选确认，恢复基线或确认前继续变化不会误发中间消息。
- 页面事件和接受基线原子提交，重复 Feed 读取不产生新 GUID，既有事件不能更新或删除。
- 页面抓取逐跳执行公网地址校验、超时、响应大小和内容类型限制；错误响应不泄露目标凭据。
- 页面 worker、失败退避和目标 HTTP 连接位于供给端；普通 RSS/Atom 和 RSSHub 回归测试保持通过。
- `pagechange://` 可以预览、订阅、轮询、进入时间线并复用现有 Action 与自主 AI 处理。

## 5A.4 验收标准

- 目录元数据、参数 schema、启用状态和秘密凭据绑定跨供给端重启保持稳定，不依赖 FOLO 官方目录。
- 参数渲染拒绝未知/缺失/越界值和模板冲突，只输出稳定且编码安全的 `rsshub://` 地址。
- `managed_only` 接受启用目录模板生成的地址，并只在供给端注入活动凭据；响应、日志和审计不泄露明文。
- 内部令牌不能访问目录管理 API，浏览器只能经实例 Owner 鉴权的核心 API 读取、渲染和测试。
- 前端支持目录搜索、分类过滤、四种参数类型、连接反馈，并复用普通 Feed 预览/订阅闭环。
- 目录增删改和测试进入哈希链审计，PostgreSQL 迁移、备份恢复、普通 RSS/RSSHub/页面来源回归全部通过。
