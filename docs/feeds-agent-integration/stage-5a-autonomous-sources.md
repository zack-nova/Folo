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
  { "id": "sources.route_catalog", "provider": "local" },
  { "id": "sources.web_list", "provider": "local" }
]
```

未配置时服务仍报告阶段四能力，前端隐藏 `rsshub://`、`pagechange://`、`weblist://` 和自有目录入口。配置后报告阶段五
能力，但 `rsshub.hosted` 继续位于 `unavailable`。

所有者运维状态新增 `source_providers`，Prometheus 新增：

```text
folo_source_provider_ready{provider="rsshub"} 0|1
folo_source_provider_ready{provider="page_change"} 0|1
folo_page_change_sources_enabled <count>
folo_page_change_sources_due <count>
folo_source_cache_ready 0|1
folo_source_cache_hits_total <count>
folo_source_cache_misses_total <count>
folo_source_requests_coalesced_total <count>
folo_source_requests_rate_limited_total <count>
folo_source_requests_concurrency_rejected_total <count>
folo_source_requests_in_flight <count>
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

## 5A.5 生产规模化

生产环境增加一个不暴露宿主端口、关闭 RDB/AOF、使用 `noeviction` 的 Redis；内存耗尽时失败关闭，不能
通过淘汰活动租约绕过容量保护。RSSHub 使用 DB 0 作为其上游路由缓存；
`feed-supplier` 使用 DB 1 保存以下可重建状态：

- 只缓存成功 2xx 响应的有界 RSSHub 响应缓存，默认 TTL 60 秒；正文上限与
  `RSSHUB_FETCH_MAX_BYTES` 一致。
- 以路由策略为单位的固定窗口计数器，默认每 60 秒最多 60 次真实上游尝试。
- 全局和每路由的带过期时间租约，默认分别为 16 和 4 个并发上游请求。

精确登记路由以 route ID 隔离，目录地址以 catalog route ID 隔离，`permissive` 模式的未登记地址以完整
逻辑 URL 隔离。Redis key 只包含这些值的 SHA-256；响应诊断 URL 已去除 RSSHub key 和秘密查询参数。
连接测试使用相同限流和并发保护，但不读取响应缓存，确保测试结果代表真实连接。

缓存命中直接复用正文、ETag、Last-Modified、Content-Type 和脱敏诊断 URL，并在本地完成条件请求 304。
缓存 miss 时，同一供给进程中只有“逻辑 URL + If-None-Match + If-Modified-Since”完全相同的并发请求才会
合并，避免把不同条件请求错误归并。多副本之间共享缓存、限流和并发租约，但 miss 合并仍是进程内能力。

生产不允许 Redis 缺失或失联后退回内存实现：启动配置要求 `REDIS_URL`，运行中协调失败返回 503，
readiness 与 provider 状态变为 unavailable。限流返回 429，容量繁忙返回 503，均携带 `Retry-After`。
Redis 丢失不会丢失 Feed、Entry、路由、凭据或页面事件；恢复后缓存和计数器自动重建。

普通 HTTP/HTTPS Feed 抓取、退避和推送链路不经过该 Redis；页面变化 worker 也保持独立调度。因此阶段
5A.5 只约束 RSSHub 上游访问，不改变“一条新 RSS Entry 对应一条常规新消息”的主路径。

桌面端运维页显示缓存状态、命中/未命中、合并、限流、容量拒绝和当前请求数。核心 `/metrics` 暴露相同
Prometheus 指标。真实数据灰度按既定决定延后，本切片只交付可控灰度所需的保护、部署和观测基础设施，
不会自动创建来源或访问新的外部站点。

## 5A.6 网页列表源

政府公告、高校通知等没有 RSS 的列表页使用稳定的 `weblist://<source-uuid>` 逻辑地址。它迁移自旧 Feeds Agent
的 `generic-web-list` 与 `generic-json-list`，决策见 ADR-0031。

```text
feed-supplier 列表 worker
  -> 公网列表页 / 列表 JSON（逐跳 SSRF 校验、meta refresh、字符集识别）
  -> CSS 选择器或 JSON 路径抽取条目，URL/标题正则过滤，可选分页
  -> 按规范化 URL（或 JSON ID）去重，新条目写入不可变 web_list_items
  -> 可选：新条目详情页抓取与白名单 HTML 清洗
  -> /v1/feeds/web-list 物化 RSS
  -> Folo FeedImporter / Entry / Action / 自主 AI
```

规则：

1. HTML 列表优先使用 `itemSelector`；未配置时自动识别包含至少两个带链接的 `li`/`article`/`tr` 的列表，跳过
   页头、导航、页脚、侧栏和分页区域。标题、链接、日期和摘要可以分别用条目内的选择器覆盖。
2. JSON 列表使用点路径、`[n]` 下标和 `[]` 通配，空路径表示根节点；链接可以来自 `urlPath` 或 `urlTemplate`。
   接口需要的查询参数直接写在目标 URL 中。
3. 没有时区的日期按来源 `timeZone` 解释（默认 `UTC`，国内来源建议 `Asia/Shanghai`）；超过当前时间 24 小时的
   日期视为无效。没有日期的条目使用发现时间。
4. 首次检查发布当前列表顶部最多 `maxItems` 条（默认 20，上限 100），之后只发布新出现的条目；已发布条目不可
   更新或删除。修改目标或抽取规则不会删除已发布条目，但会清除条件请求状态并在启用时立即重新检查。
5. 详情抓取只针对新条目，按同源间隔串行执行；详情失败或不是 HTML 时条目仍然发布，`detailStatus` 分别记为
   `failed` 或 `skipped`。
6. 抽取不到任何条目视为失败（`web_list_no_items`），按页面来源相同的指数退避并进入运维状态，提醒选择器失效。
7. 详情正文沿用旧 `official_policy` 清洗规则：去除工具栏、元数据行和页脚，追加正文旁附件，并在正文前渲染
   文号、发文机关等事实头。JSON 字段通过 `json.metadataPaths` 配置；文号只取标题括号内或单独成行的编号。
   列表缺少日期时使用详情页日期。

管理 API 同样只接受独立 `ADMIN_TOKEN`：

```text
GET    /v1/admin/web-list-sources
POST   /v1/admin/web-list-sources
GET    /v1/admin/web-list-sources/:sourceId
PATCH  /v1/admin/web-list-sources/:sourceId
DELETE /v1/admin/web-list-sources/:sourceId
POST   /v1/admin/web-list-sources/:sourceId/test
POST   /v1/admin/web-list-sources/:sourceId/check
GET    /v1/admin/web-list-sources/:sourceId/items
```

`test` 是无状态抽取预览，`check` 执行真实检查并可能发布条目。创建响应返回 `feedURL`，应用所有者把该
`weblist://` 地址粘贴进 Folo 发现输入框即可订阅。核心只在配置供给端时宣告 `sources.web_list` 能力，
`/v1/providers` 增加 `web_list` provider，Prometheus 增加：

```text
folo_source_provider_ready{provider="web_list"} 0|1
folo_web_list_sources_enabled <count>
folo_web_list_sources_due <count>
```

第一版不支持 JavaScript 渲染、登录 Cookie、自定义请求头和 POST 接口。

批量来源通过仓库外的本地预设文件导入（来源清单属于个人信息，与 AI 用户画像一样不进入仓库），
`pnpm sources:import:web-lists <preset.json>` 先停用创建、逐个预览，再只启用预览成功的来源；格式见
`apps/feed-supplier/tests/fixtures/web-lists.example.json`。

## 5A.7 平台源目录与订阅迁移

旧 Feeds Agent 的平台采集不再在供给端重写，而是映射到已有能力：

- 有原生 RSS/Atom 的来源直接订阅；其余平台采集映射为自建 RSSHub 路由目录模板（X 用户时间线、V2EX、知乎、
  华尔街见闻、财联社、雪球、GitHub、B 站、微博），预设对照固定 RSSHub 镜像的路由清单核对。
- 目录导入先停用创建，`--enable` 时在停用状态下用样例参数做真实连接测试，只有通过才启用。所有者管理接口可以测试
  停用模板；核心使用的内部目录接口和 Feed 读取仍只接受启用模板。
- 平台凭据（`TWITTER_AUTH_TOKEN`、Cookie、API Key）是 RSSHub 自身配置，通过可选 `env_file` 只交给 RSSHub 容器；
  它们不进入核心、供给端数据库或浏览器。需要浏览器的路由要求 chromium-bundled 镜像。
- 订阅清单（仓库外的本地预设）导出为 OPML，旧 `group` 成为 Folo 分类；网页列表源在导出时按名称解析为实际的
  `weblist://` 地址。核心 OPML 导入现在接受经过校验的 `rsshub://`、`pagechange://` 和 `weblist://` 地址，
  未配置供给端时这些条目会出现在导入失败列表中；属性中的 `&amp;` 等预定义实体会被解码，DOCTYPE 实体仍不展开。

## 5A.8 所有者管理网页列表源

配置 `FEED_SUPPLIER_MANAGEMENT_TOKEN`（供给端读取同一值为 `MANAGEMENT_TOKEN`）后，核心宣告
`sources.web_list_management`，桌面端“设置 → 数据源”显示网页列表源管理：列表与状态、新建/编辑全部抽取与调度
字段、带详情的连接测试、立即检查、最近条目、启停、删除、复制 `weblist://` 地址和直接订阅。决策见 ADR-0032。

```text
GET    /api/extensions/sources/web-lists
POST   /api/extensions/sources/web-lists
GET    /api/extensions/sources/web-lists/:sourceId
PATCH  /api/extensions/sources/web-lists/:sourceId
DELETE /api/extensions/sources/web-lists/:sourceId
POST   /api/extensions/sources/web-lists/:sourceId/test?detail=true
POST   /api/extensions/sources/web-lists/:sourceId/check
GET    /api/extensions/sources/web-lists/:sourceId/items?limit=20
```

这些接口只接受实例所有者会话。管理令牌只能访问供给端 `/v1/manage/web-list-sources`，不能读取凭据、目录绑定、
审计或 Feed；核心对供给端响应做严格 schema 校验后再返回浏览器。未配置管理令牌时行为与 5A.6 相同。

## 5A.10 私有 RSS 公开通道

供给端除了供自托管 Folo 使用的内部通道，还可以把来源以私有链接发布给官方 Folo 和其他阅读器，决策见
ADR-0033。设置 `PUBLIC_FEED_BASE_URL`（只能是不带路径的源站地址，生产环境必须是 HTTPS）后才提供；未设置时与之前完全相同。

- **订阅授权：** 每个使用方一个授权（例如“官方 Folo”“手机阅读器”），授权内每个来源一条独立链接
  `https://<域名>/f/<令牌>`，令牌为 256 位随机值。数据库只存令牌的 SHA-256 摘要，以及用凭据密钥加密的
  原文（用于再次导出）。可以单独轮换或作废一条链接；作废授权会同时停用它的全部链接。
- **签发校验：** 只能为供给端当前能提供的来源签发链接：`rsshub://` 需能被路由注册表解析，
  `pagechange://` 与 `weblist://` 需对应现有来源。
- **对外行为：** 公开路由不需要内部令牌，内部经同一套 `/v1/feeds/*` 读取，缓存、请求合并和限流与内部通道
  一致。无效、已轮换、已作废或来源已删除的链接一律返回 404。响应只保留 `content-type`、`ETag`、
  `Last-Modified`，附带 `Cache-Control: private, no-cache` 与 `X-Robots-Tag: noindex, nofollow`，不返回内部
  诊断头和上游错误细节。
- **限流与日志：** 每个客户端地址每分钟最多 30 次无效访问，超过后在查库之前直接返回 429；每条链接每分钟
  最多 30 次读取。计数在进程内并有容量上限。请求日志中的 `/f/` 令牌被脱敏。`TRUST_PROXY` 列出可信反向
  代理，客户端地址按其转发头识别；生产环境启用公开链接时必须配置，否则所有客户端共用代理地址的配额。
- **访问记录：** 每条链接记录最近访问时间、客户端地址和 User-Agent（同一链接每分钟最多写一次），授权列表
  汇总显示，用于发现泄露。

管理接口只接受 `ADMIN_TOKEN`，不经公网代理暴露，所有变更写入审计链：

```text
GET    /v1/admin/public-feed-grants
POST   /v1/admin/public-feed-grants                                   { name }
POST   /v1/admin/public-feed-grants/:grantId/revoke
GET    /v1/admin/public-feed-grants/:grantId/links                    不含链接地址
POST   /v1/admin/public-feed-grants/:grantId/links                    { sourceURL, title?, category? }，返回链接地址
PATCH  /v1/admin/public-feed-grants/:grantId/links/:linkId            { title?, category? }，链接地址不变
GET    /v1/admin/public-feed-grants/:grantId/export                   有效链接及其地址、标题、类别
POST   /v1/admin/public-feed-grants/:grantId/links/:linkId/rotate
DELETE /v1/admin/public-feed-grants/:grantId/links/:linkId
GET    /v1/admin/credential-usage[?grantId=]                          个人凭据依赖总览
```

**个人凭据依赖总览。** 每条有效链接按来源报告 `uses`、`none` 或 `unknown`：

- `rsshub://` 地址合并两类凭据：路由实例与匹配的目录模板绑定的供给端凭据（按名称，不含值），以及模板
  `rssHubCredentials` 声明的 RSSHub 部署凭据（环境变量名，标明是否必需）。模板未声明（`null`）或地址不属于
  任何模板时报告 `unknown`，不按“无凭据”处理；匹配时包含已停用的模板，因为 RSSHub 读取环境变量与是否在此
  启用无关。
- `weblist://` 与 `pagechange://` 第一版不支持登录 Cookie，报告 `none`。

仓库内的 `presets/rsshub-catalog.json` 已按 RSSHub 源码（2026-10-03 的 `master`）为每条路由声明凭据：X 用户
时间线必需 `TWITTER_AUTH_TOKEN`（也可改用 `TWITTER_THIRD_PARTY_API` 或开发者 API 密钥），知乎热榜、GitHub
仓库、B 站和微博路由可选使用对应 Cookie 或令牌，其余路由不使用。`sources:import:catalog --apply` 会把预设中
更新过的描述和凭据声明同步到已存在的模板（结果为 `updated`；不加 `--apply` 时报告 `outdated`），不改动模板、
参数和绑定。

**密钥轮换。** `POST /v1/admin/credentials/rotate` 同时把仍在旧密钥下的有效链接令牌重新加密，响应中的
`publicLinkRotatedCount` 为其数量；完成后旧密钥可以从 `CREDENTIAL_DECRYPTION_KEYS_JSON` 中移除，已发出的
链接地址不变。

## 配置与启动

本地最小闭环：

```bash
pnpm dev:self-hosted:sources
```

生产供给端使用独立的 `apps/feed-supplier/compose.production.yaml`，可先于核心部署。主 API 环境文件只增加：

```dotenv
FEED_SUPPLIER_URL=http://feed-supplier:3001
FEED_SUPPLIER_TOKEN=<独立的 32+ 字符随机令牌>
```

供给端专用环境文件增加：

```dotenv
FEED_SUPPLIER_ADMIN_TOKEN=<独立管理令牌>
FEED_SUPPLIER_TOKEN=<与核心 FEED_SUPPLIER_TOKEN 相同的内部令牌>
FEED_SUPPLIER_DATABASE_URL=<独立 PostgreSQL URL>
FEED_SUPPLIER_POSTGRES_PASSWORD=<独立数据库密码>
FEED_SUPPLIER_CREDENTIAL_ENCRYPTION_KEY=<base64 编码的 32 字节随机 key>
FEED_SUPPLIER_CREDENTIAL_ENCRYPTION_KEY_ID=primary-2026-08
FEED_SUPPLIER_AUDIT_HMAC_KEY=<另一个 base64 编码的 32 字节随机 key>
FEED_SUPPLIER_REDIS_URL=redis://redis:6379/1
REDIS_CONNECT_TIMEOUT_MS=5000
RSSHUB_CACHE_TTL_SECONDS=60
RSSHUB_ROUTE_RATE_LIMIT_MAX=60
RSSHUB_ROUTE_RATE_LIMIT_WINDOW_SECONDS=60
RSSHUB_GLOBAL_CONCURRENCY=16
RSSHUB_ROUTE_CONCURRENCY=4
SOURCES_REDIS_MAXMEMORY=192mb
REDIS_IMAGE=redis:8.10.0-alpine
PAGE_FETCH_TIMEOUT_MS=15000
PAGE_FETCH_MAX_BYTES=5242880
PAGE_CONTENT_MAX_BYTES=262144
PAGE_SCHEDULER_POLL_INTERVAL_MS=60000
RSSHUB_ACCESS_KEY=<另一独立随机密钥>
RSSHUB_REDIS_URL=redis://redis:6379/0
RSSHUB_IMAGE=diygod/rsshub@sha256:<经过验证的镜像摘要>
PUBLIC_FEED_BASE_URL=
TRUST_PROXY=loopback,uniquelocal
```

供给端的数据库、管理、加密、审计和 RSSHub 密钥只放在供给端环境文件；API 环境文件只保存
`FEED_SUPPLIER_URL`、`FEED_SUPPLIER_TOKEN` 及可选的网页列表管理令牌。供给端独立启动：

```bash
cp apps/feed-supplier/.env.production.example apps/feed-supplier/.env.production
node scripts/preflight-self-hosted.mjs --supplier
docker compose -f apps/feed-supplier/compose.production.yaml \
  --env-file apps/feed-supplier/.env.production up -d --wait
```

供给端默认只在宿主机 `127.0.0.1:3001` 监听，RSSHub、Redis 和供给数据库不发布宿主端口。
同一宿主机部署核心时，先创建 `folo-sources-internal` 外部 Docker 网络，再分别给供给端和核心加载
`compose.same-host-core.yaml`、`compose.same-host-supplier.yaml` 覆盖文件；只有供给端和核心 API
加入共享网络，核心通过 `http://feed-supplier:3001` 访问供给端。分处不同主机时，不加载覆盖文件，
将供给端端口仅绑定到私网或 WireGuard/Tailscale 隧道接口，并把核心 `FEED_SUPPLIER_URL` 指向该地址。
核心未配置供给端时继续独立运行。具体命令见两个应用的 README。

公开订阅链接的 HTTPS 基础地址由 `PUBLIC_FEED_BASE_URL` 设置；留空禁用公开链接。公开反向代理
只转发 `/f/*`，其余路径返回 404，且不得记录包含令牌的请求路径。Caddy 与 nginx 示例位于
`apps/feed-supplier/deploy/`；`TRUST_PROXY` 仅列入可信代理 IP、CIDR 或
`loopback`/`linklocal`/`uniquelocal`。`/f/` 端点属于 ADR-0033 后续实现。

认证/AI/指标、供给端内部认证、供给端管理、凭据加密、审计、供给数据库和 RSSHub 访问密钥必须相互独立。
数据库备份必须与当前 keyring 和审计 HMAC key 一起纳入加密备份，但不能放在同一个明文归档中。

## 5A 后续切片

5A.5 的工程开发已经完成，5A.6 网页列表源已迁入旧 Feeds Agent 的列表采集能力。真实数据灰度仍按约定延后，恢复时应先选择少量非关键路由，观察缓存命中、
429/503、上游延迟和错误率，再逐步扩大来源范围。

阶段 5B 不属于上述切片。只有 5A 真实数据灰度稳定后，才评估是否需要 FOLO 官方发现或托管获取。

## 工作量判断

- 5A.1：约 3–5 人日，代码、契约、容器、运维可见性和自动测试组成一个最小闭环。
- 5A.2：独立配置库、凭据生命周期、审计、备份恢复已完成。
- 5A.3：页面来源持久化、空基线首次发布、确认去抖、物化 Feed、调度隔离和自动测试已完成。
- 5A.4：自有目录持久化、严格参数 schema、连接测试、Owner 代理和前端表单已完成。
- 5A.5：Redis 缓存、请求合并、分布式限流/并发隔离、指标、运维 UI 和安全 Compose 已完成；剩余工作是
  独立安排真实数据灰度观察。

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

## 5A.5 验收标准

- 生产配置缺少 Redis 时拒绝启动；运行中 Redis 失联时 readiness、provider 状态和请求错误一致地失败关闭。
- 成功 RSSHub 响应跨供给进程复用且不超过正文上限；缓存 key/值不包含访问密钥或秘密查询参数。
- 同进程相同条件请求只产生一次上游访问，不同校验器不会错误合并。
- 每路由限流、每路由并发和全局并发在多个供给实例之间共享，连接测试不能绕过保护。
- 普通 RSS、页面变化、目录、凭据和 AI 流水线回归通过；Redis 清空不影响任何权威数据。
- Prometheus 与桌面运维页可见缓存、合并、限流、容量拒绝和当前请求数；真实数据灰度不在本次自动执行。
