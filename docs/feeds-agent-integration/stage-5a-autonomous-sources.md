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
{ "id": "sources.rsshub_self_hosted", "provider": "local" }
```

未配置时服务仍报告阶段四能力，前端隐藏 `rsshub://` 入口。配置后报告阶段五能力，但
`rsshub.hosted` 继续位于 `unavailable`。

所有者运维状态新增 `source_providers`，Prometheus 新增：

```text
folo_source_provider_ready{provider="rsshub"} 0|1
```

供给端不可用会生成 `source_provider_unavailable` 告警。状态和日志不得返回内部 Bearer Token 或
RSSHub `ACCESS_KEY`。

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

5A.2 完成后按以下顺序继续：

1. **5A.3 页面变化源**：定时观测、内容指纹、去抖和新 GUID Feed Entry；不修改既有 Entry。
2. **5A.4 路由目录与表单**：自有路由元数据、参数 schema、连接测试和前端管理，不调用 FOLO 官方目录。
3. **5A.5 生产规模化**：Redis 缓存、每路由限流、并发隔离和真实数据灰度。

阶段 5B 不属于上述切片。只有 5A 真实数据灰度稳定后，才评估是否需要 FOLO 官方发现或托管获取。

## 工作量判断

- 5A.1：约 3–5 人日，代码、契约、容器、运维可见性和自动测试组成一个最小闭环。
- 5A.2：独立配置库、凭据生命周期、审计、备份恢复已完成。
- 5A.3–5A.4：约 2–4 周，主要体量在调度、页面变化语义、路由 schema 和管理前端。
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
