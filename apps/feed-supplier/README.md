# Folo Feed Supplier

阶段 5A 的独立数据源供给服务。它把 `rsshub://` 路由转换为自建 RSSHub 的标准 Feed，把
`pagechange://` 页面来源的确认变化物化为新 GUID RSS Entry，并把 `weblist://` 网页列表或列表 JSON 中的
新条目逐条发布为 RSS Entry。5A.2–5A.4 使用独立 PostgreSQL 保存路由、
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
GET    /v1/admin/web-list-sources
POST   /v1/admin/web-list-sources
GET    /v1/admin/web-list-sources/:sourceId
PATCH  /v1/admin/web-list-sources/:sourceId
DELETE /v1/admin/web-list-sources/:sourceId
POST   /v1/admin/web-list-sources/:sourceId/test
POST   /v1/admin/web-list-sources/:sourceId/check
GET    /v1/admin/web-list-sources/:sourceId/items
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

## 网页列表源

政府公告、高校通知等没有 RSS 的列表页可以创建为网页列表源。每次检查抽取列表顶部最多 `maxItems` 条，
按规范化 URL（或 JSON `idPath`）去重，只发布从未见过的条目；首次检查发布当前全部条目。已发布条目不可修改。

创建一个 HTML 列表源，并抓取新条目的详情正文：

```bash
curl -fsS -H "Authorization: Bearer $FEED_SUPPLIER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"国家发展改革委通知","targetURL":"https://www.ndrc.gov.cn/xxgk/zcfb/tz/","format":"html","html":{"itemSelector":".list .u-list li"},"filters":{"includeURLPatterns":["/xxgk/zcfb/tz/"]},"detail":{"enabled":true,"contentSelectors":[".article_con",".TRS_Editor"]},"timeZone":"Asia/Shanghai","enabled":true,"intervalMinutes":360}' \
  http://127.0.0.1:3001/v1/admin/web-list-sources
```

创建一个列表 JSON 源（接口查询参数直接写在 `targetURL` 中）：

```bash
curl -fsS -H "Authorization: Bearer $FEED_SUPPLIER_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"name":"中国政府网最新政策","targetURL":"https://www.gov.cn/zhengce/zuixin/ZUIXINZHENGCE.json","format":"json","json":{"itemsPath":"","titlePath":"TITLE","urlPath":"URL","publishedAtPath":"DOCRELPUBTIME"},"detail":{"enabled":true,"contentSelectors":["#UCAP-CONTENT"]},"timeZone":"Asia/Shanghai","enabled":true,"intervalMinutes":360}' \
  http://127.0.0.1:3001/v1/admin/web-list-sources
```

先用 `POST .../test`（可加 `?detail=true` 预览第一条详情）确认选择器，再用 `POST .../check` 执行第一次真实
检查。创建响应中的 `feedURL` 可以直接粘贴进 Folo 发现输入框订阅。

抽取与运行规则：

- 未配置 `itemSelector` 时自动选择包含最多带链接 `li`/`article`/`tr` 的列表，跳过页头、导航、页脚与分页。
- `includeURLPatterns`、`excludeURLPatterns`、`includeTextPatterns`、`excludeTextPatterns` 是 JavaScript
  正则表达式，每组最多 16 条；URL 规则匹配绝对地址，文本规则匹配标题。`utm_*`、`fbclid`、`gclid` 不参与去重。
- 没有时区的日期按 `timeZone` 解释；超过当前时间 24 小时的日期视为无效，无日期条目使用发现时间并保持列表顺序。
- `maxPages` 大于 1 时沿“下一页 / next / »”等链接翻页；只有第一页使用条件请求，304 表示没有变化。
- 详情正文未配置 `contentSelectors` 时，依次尝试常见政务 CMS 正文容器、`main`/`article` 与最大文本块，
  再按白名单清洗为 HTML，上限 128 KiB。PDF、Office 等附件链接不会被下载。详情失败的条目仍然发布，
  `detailStatus` 记为 `failed`，不会在后续检查中重试。
- 详情正文会按旧 Feeds Agent `official_policy` 清洗规则处理：去掉打印 / 分享 / 扫一扫等工具栏和“发布时间：…
  来源：…”元数据行，在“上一篇 / 下一篇 / 责任编辑”处截断，并只在正文后半段遇到“版权所有 / ICP备”等页脚标记时
  截断。正文旁边的附件链接会追加为“附件”列表。
- 正文开头渲染事实头：JSON 来源通过 `json.metadataPaths`（显示名 → 字段路径，最多 12 项）配置文号、发文机关等，
  页面中的 `ContentSource` 元信息或“来源：”行与文号补充其余信息。文号只取标题括号内或单独成行的编号，正文引用的
  其他文件编号不会被当作本文文号。列表没有日期时，使用详情页元信息或“发布时间：”行中的日期。
- 一次检查的详情抓取总预算为 120 秒，同源请求间隔 `WEB_LIST_REQUEST_DELAY_MS`（默认 500 ms）；预算用尽时
  剩余新条目留到下一次检查，并清除条件请求缓存以确保下次重新读取列表。
- 抽取不到任何条目视为失败（`web_list_no_items`），按页面来源相同的指数退避，并显示在运维状态中。

相关配置：`WEB_LIST_FETCH_TIMEOUT_MS`、`WEB_LIST_FETCH_MAX_BYTES`、`WEB_LIST_REQUEST_DELAY_MS`、
`WEB_LIST_SCHEDULER_POLL_INTERVAL_MS`。

配置可选的 `MANAGEMENT_TOKEN`（核心侧为 `FEED_SUPPLIER_MANAGEMENT_TOKEN`，两者同值）后，供给端在
`/v1/manage/web-list-sources` 下提供与上面管理接口相同的网页列表接口，Folo 核心以实例所有者身份代理给“设置 → 数据源”。
该令牌只能访问网页列表源，不能访问凭据、目录、页面变化源、审计或 Feed；任何环境下它都必须与其他所有供给端秘密不同。

## 批量导入网页列表源

批量来源保存在仓库外的本地预设文件中：来源清单属于个人信息，与 AI 用户画像一样不进入仓库。格式见
[`tests/fixtures/web-lists.example.json`](./tests/fixtures/web-lists.example.json)，每个 `source` 与管理接口的创建
请求相同。导入脚本默认只校验预设并与供给端已有来源（按名称）比较，不写入任何数据：

```bash
FEED_SUPPLIER_ADMIN_URL=http://127.0.0.1:3001 FEED_SUPPLIER_ADMIN_TOKEN=... \
  pnpm --filter @follow/feed-supplier sources:import:web-lists /path/to/web-lists.json
```

`--apply` 以停用状态创建缺失来源，并对每个新来源执行一次带详情的 `test` 预览；再加 `--enable` 时，只有预览
抽取到条目、且详情页抓取成功的来源才会启用并按预设 `intervalMinutes` 调度。预览失败或抽取为空的来源保持停用并以
非零退出码提示，修正后重跑带 `--enable` 的命令即可启用之前留下的停用来源。`--only key1,key2` 只处理指定来源。

从旧 Feeds Agent 转换时，旧清洗脚本的 `body_selectors` 对应 `detail.contentSelectors`，JSON 接口的
`request.query` 直接写入目标 URL，`metadata_paths` 对应带显示名的 `json.metadataPaths`；站点改版后需要按当前
页面结构修正选择器，并先用 `test` 预览确认。

## 平台源目录与订阅迁移

[`presets/rsshub-catalog.json`](./presets/rsshub-catalog.json) 是旧 Feeds Agent 平台采集对应的 19 个自建 RSSHub
目录模板（X 用户、V2EX、知乎、华尔街见闻、财联社、雪球、GitHub、B 站、微博），已对照
`diygod/rsshub@sha256:eda756a2…`（2026-10-01）的路由清单逐个核对。导入方式与网页列表源一致，默认只校验和比较：

```bash
FEED_SUPPLIER_ADMIN_URL=http://127.0.0.1:3001 FEED_SUPPLIER_ADMIN_TOKEN=... \
  pnpm --filter @follow/feed-supplier sources:import:catalog --apply --enable
```

`--apply` 以停用状态创建缺失模板；`--enable` 会在模板仍停用时用预设样例参数做一次真实连接测试，只有测试通过才启用，
失败的模板保持停用并以非零退出码提示。管理接口 `POST /v1/admin/catalog/routes/:routeId/test` 可以测试停用模板，
内部令牌的目录接口与 Feed 读取仍只接受启用模板。

部分路由需要 RSSHub 自身的配置，这些凭据只进入 RSSHub 容器，核心和供给端都不读取：

| 模板                                                             | 需要                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `twitter-user`                                                   | `TWITTER_AUTH_TOKEN`                                                                                                  |
| `bilibili-video-search`                                          | `BILIBILI_COOKIE_<uid>`                                                                                               |
| `bilibili-user-video`、`bilibili-hot-search`、`weibo-hot-search` | chromium-bundled 镜像（`RSSHUB_IMAGE=diygod/rsshub@sha256:cacaf98a…`，2026-10-01 实测可用）；微博可选 `WEIBO_COOKIES` |
| `xueqiu-*`                                                       | chromium-bundled 镜像；2026-10-01 实测因站点反爬仍返回空结果，导入时保持停用                                          |
| `zhihu-hot`                                                      | 可选 `ZHIHU_COOKIES`，提高稳定性                                                                                      |

复制 [`.env.rsshub.example`](./.env.rsshub.example) 为 `apps/feed-supplier/.env.rsshub`（或用 `RSSHUB_ENV_FILE` 指向其他
路径），只保留填写了值的行：RSSHub 会把空字符串当作已配置。开发和生产 Compose 都以可选 `env_file` 读取它，重启 RSSHub
后重跑带 `--enable` 的导入即可启用之前留下的停用模板。

订阅清单同样保存在仓库外的本地预设文件中，格式见
[`tests/fixtures/subscriptions.example.json`](./tests/fixtures/subscriptions.example.json)：每个订阅写明 Folo
分类，以及 `url`（HTTP(S)、`rsshub://`、`pagechange://`）或引用网页列表预设 `key` 的 `webList`。先导入网页列表
预设，再导出 OPML，在 Folo“导入 OPML”中导入：

```bash
FEED_SUPPLIER_ADMIN_URL=http://127.0.0.1:3001 FEED_SUPPLIER_ADMIN_TOKEN=... \
  pnpm --filter @follow/feed-supplier sources:export:opml \
  --subscriptions ~/presets/subscriptions.json --web-lists ~/presets/web-lists.json --out subscriptions.opml
```

网页列表条目按名称在供给端查到实际的 `weblist://` 地址；尚未创建的来源会被列出并以非零退出码提示。X 订阅在配置
`TWITTER_AUTH_TOKEN` 前导入会出现在 OPML 导入结果的失败列表中，配置后重新导入即可。

官方 Folo 或其他阅读器使用公开订阅时，以同一份仓库外预设发布到一个使用方授权，再导入生成的 OPML：

```bash
FEED_SUPPLIER_ADMIN_URL=http://127.0.0.1:3001 FEED_SUPPLIER_ADMIN_TOKEN=... \
  pnpm --filter @follow/feed-supplier sources:publish \
  --grant "Official Folo" --create-grant \
  --subscriptions ~/presets/subscriptions.json --web-lists ~/presets/web-lists.json
```

默认写入按授权名命名的 OPML，文件权限为 `0600`，其中包含可读取私有来源的链接，应妥善保管。
`--dry-run` 只打印变更计划；默认保留不再出现在预设中的旧链接，加 `--revoke-missing` 才作废它们，且只要还有预设条目未能解析就拒绝执行；默认情况下有未解析条目时整个命令在任何变更前中止，加 `--allow-unresolved` 才只发布已解析的条目。
普通 HTTP(S) 订阅保持原地址，供给端来源使用授权链接。自托管 Folo 仍使用上面的
`sources:export:opml` 导出逻辑地址。

## 生产规模化

生产环境必须配置 Redis。`feed-supplier` 用 Redis DB 1 保存可重建的 RSSHub 响应缓存、每路由固定窗口
计数器，以及全局/每路由并发租约；RSSHub 自身使用 DB 0。两个服务共享 Redis 实例但不共享 key 空间。
缓存 key、限流 key 和租约 key 都只包含逻辑地址或策略标识的 SHA-256，不保存逻辑 URL、RSSHub
`ACCESS_KEY` 或路由秘密参数。Redis 使用 `noeviction`，内存耗尽会失败关闭，不能淘汰活动租约后绕过容量
保护。

生产镜像使用 [`pnpm-lock.production.yaml`](./pnpm-lock.production.yaml) 和独立的 isolated pnpm 工作区，
只安装 feed-supplier 与 feed-source-contracts 的运行依赖。修改这两个包的运行依赖后，重新生成锁并构建镜像：

```bash
pnpm --filter @follow/feed-supplier prod:lock:update
docker build -f apps/feed-supplier/Dockerfile -t folo-feed-supplier:local .
```

不要手工编辑生产锁。Docker 使用 frozen install；提交前运行
`pnpm --filter @follow/feed-supplier prod:lock:check` 检查锁是否与运行依赖同步。

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

## 独立生产部署

供给端可以先于 Folo 核心启动。复制环境模板并替换所有示例密钥；`FEED_SUPPLIER_TOKEN` 是供给端的
`INTERNAL_TOKEN`，只在核心需要连接时把相同值写入核心环境文件。数据库 URL 中的密码必须与
`FEED_SUPPLIER_POSTGRES_PASSWORD` 一致，且应进行 URL 编码。RSSHub 镜像应固定到验证过的 digest；需要浏览器的
路由应选带 Chromium 的镜像。

```bash
cp apps/feed-supplier/.env.production.example apps/feed-supplier/.env.production
node scripts/preflight-self-hosted.mjs --supplier
docker compose -f apps/feed-supplier/compose.production.yaml \
  --env-file apps/feed-supplier/.env.production up -d --wait
```

默认只把供给端的 `3001` 端口发布到宿主机 `127.0.0.1`；RSSHub、Redis 和供给数据库没有宿主端口，
并且只在供应端私有 Docker 网络中。`FEED_SUPPLIER_BIND_ADDRESS` 和 `FEED_SUPPLIER_PORT` 可修改宿主绑定；
不同主机连接时只绑定私网接口或隧道接口，不直接暴露在公网。`PUBLIC_FEED_BASE_URL` 留空会禁用公开订阅链接；
启用时填入 HTTPS 域名基础地址，例如 `https://feeds.example.com`。`TRUST_PROXY` 只列入可信代理地址段，
支持 IP、CIDR、`loopback`、`linklocal`、`uniquelocal`。

公开订阅仅允许通过 TLS 反向代理访问 `/f/*`。示例见
[`deploy/Caddyfile.example`](./deploy/Caddyfile.example) 和
[`deploy/nginx.conf.example`](./deploy/nginx.conf.example)：其他路径返回 404，代理不记录含令牌的请求路径，
并转发客户端地址。管理接口、内部 Feed 接口及 `/ready` 只通过本机或私网访问。当前 `/f/` 端点由
ADR-0033 的后续实现提供；部署配置不会自行创建该端点。

同一宿主机运行核心时，先创建一次共享网络，再用两个独立 Compose 项目的同宿主覆盖文件启动。
只有 `api` 和 `feed-supplier` 加入该网络，核心不能直接访问 RSSHub、Redis 或供给数据库：

```bash
docker network create folo-sources-internal
docker compose -f apps/feed-supplier/compose.production.yaml \
  -f apps/feed-supplier/compose.same-host-core.yaml \
  --env-file apps/feed-supplier/.env.production up -d --wait
```

核心的 `FEED_SUPPLIER_URL` 设为 `http://feed-supplier:3001`。不同主机时，不使用同宿主覆盖文件；
核心把 `FEED_SUPPLIER_URL` 指向供应端私网地址或 WireGuard/Tailscale 隧道地址，并开放对应的私网绑定端口。
两种拓扑的核心启动命令见 [`apps/server/README.md`](../server/README.md)。不连接核心时，供给端仍可独立运行。

备份与恢复演练脚本仍支持开发 Compose。对独立生产 Compose，只需指定供给端 Compose 与环境文件：

```bash
export FEED_SUPPLIER_COMPOSE_FILE="$PWD/apps/feed-supplier/compose.production.yaml"
export FEED_SUPPLIER_SOURCES_ENV_FILE="$PWD/apps/feed-supplier/.env.production"
pnpm sources:backup ./feed-supplier.dump
pnpm sources:restore:drill ./feed-supplier.dump
```

`FEED_SUPPLIER_MAIN_ENV_FILE` 在这个独立部署中不需要。备份文件应与凭据加密 keyring 和审计 HMAC key
一起保管，恢复演练使用隔离临时数据库，不覆盖运行中的供给数据库。

生产必须设置彼此独立的内部、管理、数据库、凭据加密、审计和 RSSHub 密钥。阶段 5A 完整契约见
[`stage-5a-autonomous-sources.md`](../../docs/feeds-agent-integration/stage-5a-autonomous-sources.md)。
