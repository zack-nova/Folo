# 阶段 5B：官方托管获取（第一刀）

- 状态：计划中，尚未开始实现
- 决策：[ADR-0034](./adr/0034-acquire-selected-sources-through-the-official-folo-account.md)（`proposed`）
- 已核对的官方 SDK 版本：`@follow-app/client-sdk` `0.3.96`

## 目标

让应用所有者把个别 `rsshub://` 来源改由自己的官方 Folo 账号获取，核心、客户端和既有数据不变。

完成后的使用方式：

1. 所有者在供给端关联官方账号。
2. 对某个 `rsshub://` 地址建立官方获取绑定。
3. 自托管 Folo 照常订阅和刷新这个地址，内容来自官方托管的 RSSHub。
4. 解绑后该地址回到自建 RSSHub。

## 不在第一刀范围内

- 标准 `https://` Feed、`pagechange://`、`weblist://` 的官方获取。
- 前端入口。关联、绑定和解绑只有管理接口和命令行。
- 自动降级、官方恢复后的切回、切换后的七天重叠拉取。
- 官方 Entry ID 映射、跨提供方重复候选和字段冲突记录。
- 官方 RSSHub 路由目录、发现、Trending、AI、Action 和已读同步。
- 官方账号中历史 Entry 的整批回填；每次读取只取最新一页。
- 多个官方账号。

## 前置条件

- [stage-5a-autonomous-sources.md](./stage-5a-autonomous-sources.md) 约定“5A 真实数据灰度稳定后，才评估
  官方发现或托管获取”。真实灰度目前仍延后。5B.0 只读探查可以先做；5B.1 之后的实现开始前，需要所有者
  确认是否放宽这一约定。
- ADR-0034 的两个否决条件在 5B.0 得到确认。

## 用到的官方接口

供给端只调用下表中的接口，由允许清单约束。路径相对官方 API 地址（官方命令行默认 `https://api.folo.is`）。

| 用途                         | 方法与路径                     | 请求要点                               |
| ---------------------------- | ------------------------------ | -------------------------------------- |
| 校验令牌、读取账号与额度     | `GET /better-auth/get-session` | Bearer 令牌                            |
| 列出官方账号已有订阅         | `GET /subscriptions`           |                                        |
| 查询 Feed、取得官方 Feed ID  | `GET /feeds`                   | `url`                                  |
| 创建影子订阅                 | `POST /subscriptions`          | `url`、`isPrivate: true`               |
| 删除自己创建的影子订阅       | `DELETE /subscriptions`        | `feedId`                               |
| 读取某个 Feed 的最新一页条目 | `POST /entries`                | `feedId`、`limit`、`withContent: true` |

请求和响应形状以 SDK `0.3.96` 的类型为起点，以 5B.0 录制的真实样本为准。

## 切片

### 5B.0 官方接口探查

只读探查，除创建并删除一个测试影子订阅外不改动官方账号。不写产品代码。

- 用所有者自己的账号逐项验证 ADR-0034“待验证”清单，结论写回本文件。
- 把用到的每个接口的成功、未授权、限流和额度拒绝响应保存为脱敏样本，放在
  `apps/feed-supplier/tests/fixtures/folo-official/`。样本不含令牌、邮箱和真实用户 ID。
- 选一个自建 RSSHub 也能取得的路由，对比两边的 GUID。
- 产出：通过或否决的结论。否决时把 ADR-0034 标记为 `rejected` 并停止。

### 5B.1 契约与配置

- `packages/feed-source-contracts`：provider ID 增加 `folo_official`；增加该 provider 的健康字段（账号
  状态、有效绑定数、失败绑定数）、绑定和账号的管理契约类型、读取错误码
  `official_auth_invalid`、`official_binding_inactive`、`official_rate_limited`、`official_unavailable`。
- `apps/server/src/feeds/feed-supplier-fetcher.ts`：provider 健康 schema 接受 `folo_official`。该 schema 是
  严格枚举，旧核心遇到未知 provider 会把全部 provider 判为不可用，因此**核心必须先于供给端发布**；
  供给端只在配置了官方 API 地址时才报告该 provider。
- `apps/feed-supplier/src/config.ts`：
  - `FOLO_OFFICIAL_API_URL`：未设置时能力不存在；生产环境必须是 HTTPS，不得带凭据、查询或片段。
  - `FOLO_OFFICIAL_ENTRY_LIMIT`（默认 50）、`FOLO_OFFICIAL_CACHE_TTL_SECONDS`（默认 300）、
    `FOLO_OFFICIAL_FETCH_TIMEOUT_MS`、`FOLO_OFFICIAL_RATE_LIMIT_MAX` 与窗口、`FOLO_OFFICIAL_CONCURRENCY`
    （默认 2）。
- 测试：契约单测；配置校验单测；核心对含 `folo_official` 和不含它的 provider 列表都能解析。

### 5B.2 官方账号关联

- 迁移 `007_official_acquisition.sql`，表 `official_accounts`：`id`、`external_user_id`、`credential_id`
  （引用 `source_credentials`）、`status`（`active`、`auth_invalid`、`unlinked`）、`role`、
  `rsshub_subscription_limit`、`linked_at`、`last_verified_at`、`auth_invalid_at`、`unlinked_at`。部分唯一
  索引保证最多一个未解除的账号。
- 新文件 `apps/feed-supplier/src/folo-official-client.ts`：薄客户端，只能发出上表中的方法和路径；超时、
  响应体大小上限、严格响应校验、如实的 User-Agent；错误归类为未授权、限流、额度拒绝、不支持的路由、
  暂时错误。
- 管理接口（仅 `ADMIN_TOKEN`，全部写入审计链，审计不记录令牌）：

  ```text
  GET    /v1/admin/official/account            状态、官方用户 ID、角色、额度；不含令牌
  POST   /v1/admin/official/account            { token }，校验后加密保存
  POST   /v1/admin/official/account/verify     重新校验并刷新额度
  DELETE /v1/admin/official/account            解除关联；全部绑定进入 pending_deletion
  ```

- 命令行 `pnpm --filter @follow/feed-supplier sources:official link|status|verify|unlink`。`link` 从标准
  输入读取令牌，不接受命令行参数。
- 凭据密钥轮换（`POST /v1/admin/credentials/rotate`）覆盖官方令牌。
- 测试：内存与 PostgreSQL 仓库；关联、校验、未授权转 `auth_invalid`、解除关联；允许清单拒绝表外请求；
  读取接口和审计中不出现令牌。

### 5B.3 获取绑定与影子订阅

- 同一迁移，表 `official_acquisition_bindings`：`id`、`source_url`、`account_id`、`external_feed_id`、
  `origin`（`created`、`adopted`）、`status`（`pending`、`active`、`failed`、`pending_deletion`、
  `deleted`）、`created_at`、`activated_at`、`last_creation_error`、`disabled_at`、`delete_after`、
  `deleted_at`、`last_cleanup_error`、`next_cleanup_retry_at`、`last_success_at`、`last_error_code`、
  `last_error_summary`、`consecutive_failure_count`。部分唯一索引保证每个逻辑地址最多一条未删除的绑定。
- 建立绑定的校验：地址是合法的 `rsshub://` 逻辑地址；不含秘密查询参数；对应路由实例没有绑定供给端凭据；
  没有有效的公开链接；官方账号为 `active`。公开链接签发侧增加对称校验。
- 建立流程：写入 `pending` → 查询官方是否已订阅 → 已订阅记 `adopted`，否则创建私有订阅记 `created` →
  保存官方 Feed ID 并转 `active`。失败转 `failed` 并保存错误摘要，可重试。
- 解绑：转 `pending_deletion`，`delete_after` 为七天后；读取立即回到自建 RSSHub。七天内对同一地址重新
  绑定时复用原记录。清理任务挂在供给端现有调度循环上，到期后只删除 `created` 的影子订阅；删除失败时保留
  错误和下次重试时间。
- 管理接口：

  ```text
  GET    /v1/admin/official/subscriptions       官方账号中的 rsshub:// 订阅及其是否已绑定（只读）
  GET    /v1/admin/official/bindings
  POST   /v1/admin/official/bindings            { sourceURL }
  POST   /v1/admin/official/bindings/:id/retry
  DELETE /v1/admin/official/bindings/:id
  ```

- 命令行 `sources:official subscriptions|bind|unbind|bindings`。`bind` 在执行前打印将要发生的事：该地址
  会被订阅到所关联的官方账号、占用一个订阅额度。
- 测试：状态机每条迁移；`adopted` 的订阅永不被删除；七天内复用；额度拒绝转 `failed`；与公开链接互斥的
  两个方向；清理失败后的重试。

### 5B.4 读取路径

- `GET /v1/feeds/rsshub` 在解析路由注册表之前查绑定，行为见 ADR-0034。`managed_only` 模式下，有 `active`
  绑定的地址不要求存在路由实例。
- 新文件 `apps/feed-supplier/src/folo-official-feed.ts`：把 Feed 元数据和 Entry 列表渲染为 RSS 2.0（标题、
  链接、`guid`、发布时间、作者、正文、媒体与附件）。渲染结果的 SHA-256 作为 `ETag`。
- 复用 `SourceResponseCache` 和请求合并，缓存键与自建路径区分；限流与并发使用 5B.1 的独立配置。
- 响应头 `x-folo-upstream-url` 报告官方接口地址（不含任何凭据），核心现有获取诊断即可显示。
- 错误映射：未授权 → 账号转 `auth_invalid`，返回 503 `official_auth_invalid`；限流 → 429 并透传
  `Retry-After`；其余 → 502 `official_unavailable`。每次结果更新绑定的成功时间或失败计数。
- 测试：用 5B.0 的样本驱动的渲染快照；304；缓存命中不调用官方；`auth_invalid` 后不再发出请求；
  核心侧 `FeedSupplierFetcher` 加 `parseFeed` 对渲染结果的端到端单测。

### 5B.5 可见性与运维

- 供给端 `GET /v1/providers` 报告 `folo_official`。
- 核心：provider 可用时宣告 `sources.folo_official_acquisition`；`/metrics` 增加账号状态、有效与失败绑定
  数；账号 `auth_invalid` 和绑定持续失败进入现有结构化告警。运维页的 provider 摘要增加一行。
- 个人凭据总览把已绑定来源报告为使用“官方 Folo 账号”。
- 文档：`apps/feed-supplier/README.md` 的操作说明；本文件补“验收结果”；`README.md` 索引。
- 测试：核心能力门控单测；运维页有与无该 provider 两种状态；`packages/compat-contracts` 契约检查不新增
  官方 SDK 调用。

### 5B.6 真实来源灰度

- 选两到三个自建 RSSHub 抓不稳的来源绑定，观察一周：读取成功率、官方限流次数、令牌是否失效、条目是否
  缺失或重复、官方账号额度占用。
- 演练一次回退：解绑一个来源，确认它回到自建 RSSHub，且既有 Entry 不变。
- 灰度通过后把 ADR-0034 改为 `accepted`。

## 发布顺序与回滚

1. 发布核心（5B.1 的 schema 放宽）。
2. 发布供给端并执行迁移；此时未设置 `FOLO_OFFICIAL_API_URL`，行为与之前相同。
3. 设置 `FOLO_OFFICIAL_API_URL`，关联账号，逐个绑定。

回滚：解除账号关联或移除 `FOLO_OFFICIAL_API_URL`，所有地址回到自建 RSSHub。迁移只新增表，不需要回退。
两个镜像都要重新构建，并各自运行 `prod:lock:check`。

## 验收标准

- 未配置官方 API 地址时，供给端和核心的行为、能力清单和 provider 列表与阶段 5A 完全相同。
- 绑定一个来源后，自托管 Folo 能预览、订阅、刷新和阅读它，Entry 经过本地 Action 和评估。
- 官方令牌只以密文存在于供给端数据库；核心数据库、浏览器、日志、审计和任何读取接口中都不出现。
- 供给端对官方账号的写操作只有创建和删除自己创建的影子订阅；所有者原有的官方订阅不被修改或删除。
- 官方不可用或令牌失效时，只有已绑定的来源停止更新并出现告警；其他来源、阅读、AI 和同步不受影响。
- 解绑后来源回到自建 RSSHub，本地 Feed、Subscription、Entry 的 ID 不变。
- 已绑定来源不能签发公开链接，有公开链接的来源不能绑定。

## 工作量判断

- 5B.0：约 0.5–1 人日，取决于官方接口是否如预期。
- 5B.1–5B.2：约 2 人日。
- 5B.3：约 2–3 人日，状态机和清理任务是主要部分。
- 5B.4：约 2 人日。
- 5B.5：约 1–2 人日。
- 5B.6：一周观察，人工投入很少。

最大的不确定性不在代码量，而在 5B.0：官方接口是否接受非官方客户端、会话令牌能维持多久。

## 后续切片

按价值排序，均需单独决策：

1. 所有者在 Folo 设置页查看绑定状态和发起绑定（令牌录入仍留在命令行）。
2. 按错误类型自动降级到预先配置的自建路由，以及切换后的重叠拉取和去重记录。
3. 标准 `https://` Feed 的官方获取。
4. 官方 RSSHub 路由目录和发现。
5. 官方账号历史 Entry 的回填。
