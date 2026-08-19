# FOLO 融合改造方案

## 目标

以 FOLO 的客户端、阅读交互和订阅模型为产品底座，由自有服务作为业务与数据权威来源，并为 FOLO 增加可追溯的条目评估与可靠处理执行能力。FOLO 官方 API 只作为可选能力提供方，通过适配器按需接入，不拥有本应用的评估、处理作业、画像或 Taxonomy 主数据。

## 首期不做

- 不在核心中保存同一 Entry 的多个内容版本
- 不创建假聚合 Feed
- 不扩展 FOLO List 为主体
- 不新增关注主体模型
- 不实现跨平台主体聚合及主体领域分类
- 不实现配置归档与恢复
- 不实现用户条目标注的 UI、API 或同步投影
- 不迁移现有 Feeds Agent 前端
- 不把非 Feed 平台采集逻辑或凭据放入核心；它们通过独立 `feed_supplier` 接入

## 保留 FOLO 的能力

- Feed、Subscription、Entry、Category、List、Inbox
- Category 保持订阅组织语义，不承载单条 Entry 的 Taxonomy 内容分类
- 已读、未读、收藏与多内容形态阅读
- 摘要、翻译、Readability 与正文阅读
- Action 规则配置界面
- AI Task 定时报告
- 桌面、Web、移动端及本地缓存投影
- OPML 导入导出与普通订阅管理

## 服务边界

- 自有服务保存 Feed、Subscription、Entry、Action、评估结果、处理作业、用户画像和 Taxonomy 等权威数据
- FOLO 客户端通过自有 API 读取和改变这些数据，并在本地 SQLite 保存可重建的缓存投影
- FOLO 官方 API 可以提供摘要、翻译、Readability、Feed 发现或其他适合复用的能力
- 官方能力通过适配层调用；内部 Entry ID、评估结果和作业状态不依赖官方 API 的私有存储模型
- `feed_supplier` 仅以 RSS 发布器身份提供 Feed；阶段 5A 契约约束其服务边界、安全和运维，内部平台实现继续独立演进

页面变化后续由 `feed_supplier` 发布具有新 GUID 的不可变 RSS 条目，自有服务将其作为普通新 Entry 读取。

## 开发阶段路线

### 阶段 0：边界冻结与 FOLO 本地可运行

目标是把 FOLO 作为可改造底座稳定跑起来，并冻结首期不做的范围。

- 固定 FOLO 客户端、Client SDK、数据库 schema 的已验证版本组合
- 跑通 FOLO Web/Desktop 的本地开发环境和基础阅读链路
- 梳理前端实际调用的 API 路径，形成首期 **FOLO API 兼容子集**
- 建立契约测试骨架：请求、响应、错误码、流式响应和本地 SQLite 投影
- 明确首期不做：主体聚合、假聚合 Feed、用户条目标注、配置归档、官方能力适配

验收标准：FOLO 原生阅读、订阅、已读/收藏等基础功能可以在固定版本上稳定复现；未进入兼容子集的能力有明确隐藏或 `501 capability_not_implemented` 策略。

### 阶段 1：自有权威后端与最小 FOLO 兼容门面

目标是让 FOLO 客户端只连接自有服务，先不接官方。

- 实现 Feed、Subscription、Entry、阅读状态、收藏、Category、List 的自有权威存储
- 实现首期 FOLO API 兼容门面，只覆盖前端实际使用接口
- 实现标准 RSS/Atom 的本地获取、轮询、去重和 Entry 导入
- 建立客户端本地缓存投影同步，不把 SQLite 当作权威存储
- 保留 FOLO 原有摘要、翻译、Readability 的本地结果表语义
- 对接 OPML 导入导出和普通订阅管理

验收标准：不依赖 FOLO 官方 API，也能完成订阅、拉取、阅读、已读/收藏、Category/List 组织和基础同步。

### 阶段 2：Entry Evaluation 与 Processing Job

目标是把本应用的 feed_core 价值沉到自有服务里，形成可追溯的逐条评估和可靠执行。

- 扩展 Action：增加 `evaluate` 操作，只声明匹配和处理意图
- 新增 `entry_evaluations`、`entry_current_evaluations`
- 新增 `processing_jobs`、`processing_attempts`
- 实现用户画像、Taxonomy、处理器版本、评分公式版本的快照追溯
- 实现作业幂等、排队、运行、失败、重试、`superseded` 和 `force_rerun`
- 实现成功评估更新当前指针、失败不影响当前评估、历史回滚
- 评估处理器附带摘要时写入 `summaries`，不塞进评估历史
- 完成历史和 Attempt 的保留、清理规则

验收标准：标准 RSS/Atom 导入的 Entry 可以自动或手动评估；时间线能读到当前评估；失败、重试、强制重评和回滚语义稳定。

### 阶段 3：FOLO 前端融合体验

目标是把新增能力变成 FOLO 阅读体验的一部分，而不是另起一套前端。

- 时间线批量读取 Entry 扩展投影：当前评估摘要和处理状态
- 新增精选视图：`overall_score >= 70` 作为候选，按 `ranking_score` 排序
- 展示综合分、推荐理由、一级/二级分类、评估标签、旧配置提示
- 支持按评分、Entry 内容分类、评估标签、处理异常筛选
- 支持范围重评预览、提交和结果统计：created/reused/already_satisfied/superseded/skipped
- 显示 queued/running/failed/succeeded 状态、失败摘要和重试入口
- 设置页管理用户画像、Taxonomy、处理器和评分公式版本
- 保持 FOLO Category/List 的原生语义，不被 Entry Evaluation 分类和标签污染

验收标准：用户可以只在 FOLO 界面内完成阅读、精选、筛选、重评、失败恢复和配置管理。

### 阶段 4：本地获取与运行稳定化

目标是把自有核心变成可长期使用的产品，而不是 demo。

- 强化标准 RSS/Atom 获取的调度、退避、错误摘要和诊断
- 建立数据迁移、备份、恢复和版本升级检查
- 完成 Processing Job、Attempt、大体积诊断载荷的清理任务
- 增加契约测试、端到端回归、性能基准和大量 Entry 的投影分页测试
- 完善部署、健康检查、日志、告警和回滚流程
- 预留 `feed_supplier` 作为外部 RSS 发布器接入，但不实现其内部能力

验收标准：即使完全不接 FOLO 官方能力，也可以长期使用自有后端完成订阅、获取、阅读、评估、精选和同步。

### 阶段 5A：自主数据源扩展

目标是在不依赖 FOLO 官方后端的前提下扩展来源类型。

- 以独立 `feed_supplier` 接入自建 RSSHub，核心只消费标准 RSS/Atom
- 使用 `rsshub://` 保存稳定逻辑身份，实例地址和凭据仅存在服务端
- 增加 provider capability、健康状态、指标、告警和前端门控
- 已实现独立来源配置库、加密凭据、路由实例、哈希链审计和独立备份恢复
- 已实现隔离的页面变化调度、空基线首次发布、内容指纹、五分钟候选确认和 `pagechange://` 物化 Feed
- 页面变化发布具有新 GUID 的不可变 Feed Entry，不改写既有 Entry；核心读取 Feed 时不访问目标网页
- 已实现自有路由目录、严格参数 schema、连接测试、Owner 代理和能力门控前端表单
- 后续完成缓存、每路由限流、并发隔离和真实数据灰度

验收标准：关闭 FOLO 官方能力时，自建 RSSHub 来源仍可完成预览、订阅、轮询、阅读、AI 处理和故障恢复；
供给端凭据不会进入浏览器或核心数据库。

详细契约见 [`stage-5a-autonomous-sources.md`](./stage-5a-autonomous-sources.md)。

### 阶段 5B：官方能力适配，最后接入

目标是在自有核心稳定后，把 FOLO 官方能力作为可选增强，而不是基础依赖。

- 增加官方账号关联和服务端凭据管理
- 实现 FOLO 官方能力适配器和能力路由策略
- 先接 RSSHub 路由目录与发现能力
- 再接官方托管 RSSHub 获取、Twitter/X、Telegram 路由
- 对选择官方获取的单个 Feed 创建官方影子订阅和外部资源映射
- 实现官方获取授权、影子订阅待删除期、获取诊断和获取提供方降级
- 把官方反爬、轮询维护视为官方托管获取的内部能力，不承诺独立 API
- 官方能力故障只熔断对应获取能力，不影响本地 Feed、Entry、AI、Action、评估、阅读和同步

验收标准：官方能力关闭、失效或不可用时，自有核心仍完整可用；官方只增强来源获取能力，不拥有本应用主数据。

## 扩展 FOLO Action

在现有 Action 结果中增加“执行条目评估”操作。Action 继续负责匹配 Entry 和声明要执行的操作，不直接承担队列、重试或结果存储。

建议配置：

```yaml
evaluate:
  processor: personal-relevance-v1
  profile: default
  taxonomy: default
  priority: normal
```

现有 `summary`、`translation`、`readability` 和其他 Action 保持原有语义。AI Task 继续负责按时间计划生成跨条目报告，不参与逐条 Entry 的权威评分。

## 新增权威数据

### Entry 评估

`entry_evaluations` 在自有服务中保存每次成功产生的不可变 Entry 评估：

- `id`
- `entry_id`
- `importance_score`
- `timeliness_score`
- `relevance_score`
- `overall_score`
- `recommendation_reason`
- `primary_category`
- `secondary_category`
- `tags_json`
- `processor_type`
- `processor_name`
- `processor_version`
- `score_formula_version`
- `profile_snapshot_id`
- `taxonomy_snapshot_id`
- `processed_at`
- `details_json`

综合分由后端根据三维评分和版本化公式计算。FOLO 已有摘要和翻译继续分别保存在 `summaries` 与 `translations`，不复制到评估表。

`tags_json` 只保存处理器生成的评估标签，随这条 `entry_evaluations` 历史不可变保存。它不同步为 FOLO Category、FOLO List 或用户人工标签。首期不实现用户条目标注；用户未来需要手动整理 Entry 时，再写入独立的用户条目标注数据。

评估处理器可以在同一次调用中附带产出摘要，但摘要作为摘要 Action 产物写入 `summaries`，不进入 `entry_evaluations.details_json` 充当主要阅读摘要。摘要写入失败只影响摘要产物状态，可以记录到 Job 的执行元数据或摘要状态中；只要评估写入成功，评估 Job 仍可成功完成。

评估结果不放入 `entries.settings`。评估具有独立的查询、排序、筛选、重试、追溯和更新周期；把完整结果塞进 JSON 设置会削弱索引能力，并混淆 Action 指令与 Action 产物。`entries.settings` 最多保存 `evaluate` 是否生效及其策略引用。

评估在领域上属于应用所有者的个性化数据，而不是 Entry 的全局属性。首期单人私有部署不为此增加固定 `user_id`；每次评估通过用户画像和 Taxonomy 快照追溯判断上下文。进入多用户阶段时再显式迁移资源归属和唯一键。

`entry_current_evaluations` 保存每个 Entry 当前使用的评估指针：

- `entry_id`
- `evaluation_id`
- `selected_at`
- `selection_reason`

重处理、范围重评或强制重评成功时新增一条不可变 `entry_evaluations`，并在同一事务中更新当前指针，不覆盖旧评估。即使新综合分低于旧评估、分类发生变化，或新评估不再满足精选候选门槛，也必须更新当前指针。默认保留最近十个评估，且至少保留最近一百八十天内的评估；超出两项条件的旧历史才可由清理任务删除。

重评失败只更新 Processing Job、Attempt 和错误摘要，不清空、不覆盖、不标记不可用当前评估。时间线和精选继续读取原当前评估；如果原评估已经是配置过期评估，可以叠加显示“旧配置 / 重评失败”的轻提示。

时间线和精选只读取当前评估。详情页可以查看历史评估、评分差异、处理器版本、画像和 Taxonomy 快照；用户回滚时只切换当前指针，不重新执行 AI。被当前指针引用的评估不得被清理。精选列表随新的当前评估重新计算，不能为了保留旧精选展示继续使用旧高分评估。

`overall_score` 是评估事实，不因时间流逝而变化。精选视图另外计算展示排序分：

```text
ranking_score = overall_score × 2 ^ (-age / half_life)
```

- 精选候选先按当前评估 `overall_score >= 70` 筛选
- 精选候选门槛首期全局固定，不按 Taxonomy 分类覆盖
- `age` 使用 Entry 发布时间与查询时刻的间隔
- 年龄基准优先使用可靠的原始发布时间；缺失时使用提供方首次发现时间，再缺失时使用本地首次导入时间
- 原始发布时间晚于查询时刻超过二十四小时时视为不可信，回退到下一年龄基准
- 默认 `half_life` 为七天
- Taxonomy 分类只可以覆盖默认半衰期，例如长期研究内容使用更长半衰期
- `ranking_score` 在查询时计算或由可重建投影缓存，不写回不可变评估历史
- 精选候选按 `ranking_score` 降序，同分时按发布时间降序
- 界面展示原始综合分，并说明精选排序考虑了发布时间；排序分可以在详情或解释提示中查看
- 详情中的排序解释可以显示本次采用的年龄基准及时间

### 配置快照

- `processing_profile_snapshots`
- `processing_taxonomy_snapshots`

快照保存不可变内容、版本和哈希，使既有评估可以追溯当时使用的用户画像与分类规则。

用户画像或 Taxonomy 更新后：

- 新进入处理的 Entry 使用最新配置快照
- 处理器版本、评分公式版本、用户画像或 Taxonomy 更新后，既有 Entry 不自动进入全量重评，当前评估继续保留
- 当前评估使用的处理器版本、评分公式版本、画像或 Taxonomy 不是最新版本时，标记为 `configuration_outdated`
- 用户可以按发布时间范围、Feed、Entry 内容分类、精选范围或明确选择的 Entry 发起批量重评
- 批量重评提交前必须预览匹配条目数量、预计调用量或成本，以及将使用的画像和 Taxonomy 版本
- 批量重评为每个 Entry 创建、复用或跳过普通 Processing Job，遵循相同的队列、失败、重试和评估历史规则
- 批量重评默认跳过已经拥有同配置当前评估的 Entry，并在提交结果中计入 `already_satisfied`
- 用户显式选择强制重评时，可以为已经满足的 Entry 创建新的同配置 Processing Job
- 更新处理器、评分公式、画像或 Taxonomy 本身不删除、不覆盖既有评估历史
- 配置过期评估继续参与精选和默认排序，不降低既有综合分
- 时间线与精选对配置过期评估显示轻量“旧配置”标识
- 精选页支持筛选配置过期评估，并直接以当前筛选范围发起范围重评
- 配置过期评估重评失败后，原评估继续可读并继续参与精选；失败只进入处理状态和错误摘要

### 处理执行

`processing_jobs` 保存条目需要完成的处理工作：

- `id`
- `entry_id`
- `processor_name`
- `processor_version`
- `score_formula_version`
- `profile_snapshot_id`
- `taxonomy_snapshot_id`
- `status`：`queued`、`running`、`succeeded`、`failed`、`superseded`
- `priority`
- `attempt_count`
- `queued_at`
- `started_at`
- `finished_at`
- `next_retry_at`
- `last_error_code`
- `last_error_summary`
- `idempotency_key`
- `force_rerun`

`idempotency_key` 由 `entry_id`、处理目的、处理器名称、处理器版本、评分公式版本、用户画像快照和 Taxonomy 快照组成。处理目的表示要产出的能力，例如 `entry_evaluation`；Action 命中、范围重评、手动重试等只是触发来源，不进入幂等键。

`idempotency_key` 用于 `queued` 和 `running` 活跃作业判重，不要求在所有历史 Job 中全局唯一。显式强制重评可以在旧 Job 已进入终态后，创建新的同 `idempotency_key` Job，并通过 `force_rerun` 和审计元数据说明原因。

创建 Processing Job 时：

- 已有同配置当前评估且不是强制重评：自动 Action 直接视为已满足，不创建 Job；范围重评计入 `already_satisfied`。同配置必须同时匹配处理目的、处理器名称、处理器版本、评分公式版本、用户画像快照和 Taxonomy 快照
- 已有同 `idempotency_key` 的 `queued` 或 `running` Job：不创建重复 Job，返回或记录复用既有 Job
- 自动 Action 命中：已有活跃 Job 时跳过；若新请求优先级更高且既有 Job 尚未开始，可以提升优先级
- 范围重评：已有同配置活跃 Job 时复用，并在提交结果中计入 `reused`
- 失败重试：复用原 Job 增加新的 Attempt，不创建并行 Job
- 已失败的 Job 不因后续自动 Action 再次命中而自动重试，必须由用户重试或范围重评显式触发
- 用户强制重评遇到同配置活跃 Job 时，首期提示“处理中”并复用既有 Job，不提供并行强制覆盖
- 用户强制重评且没有同配置活跃 Job 时，新建 `force_rerun=true` 的 Job；成功后新增不可变评估历史并更新当前评估

不同配置命中同一 Entry 时：

- 同一 Entry 的同一处理目的首期最多一个 `running` Job
- 旧配置 Job 已经 `running`：新配置 Job 可以创建为 `queued`，等待旧 Job 结束后再执行
- 旧配置 Job 仍是 `queued`：新配置 Job 可以把旧 Job 标记为 `superseded`，并通过 `superseded_by_job_id` 指向新 Job
- `superseded` 是终态，不产生 `entry_evaluations`，不更新 `entry_current_evaluations`
- 旧配置运行中 Job 完成时仍按正常事务写入评估；如果已有新配置 Job 排队，该评估会被标记为配置过期，并在新配置 Job 成功后被新的当前评估替代

`processing_attempts` 保存每次实际执行：

- `id`
- `job_id`
- `attempt_number`
- `status`
- `started_at`
- `finished_at`
- `error_summary`
- `execution_metadata_json`

成功执行应在同一事务中新增不可变 Entry 评估、更新当前评估指针并完成 Job。若本次处理附带摘要，摘要写入应走 FOLO 原有摘要结果存储；摘要失败不回滚已经成功写入的 Entry Evaluation。

### 处理历史保留

- `entry_current_evaluations` 指向的当前有效评估长期保留
- 历史 `entry_evaluations` 默认保留最近十个，且至少保留最近一百八十天
- `processing_jobs` 长期保留最新状态、累计尝试次数、关键时间和最后错误摘要
- 成功的 `processing_attempts` 保留三十天
- 失败的 `processing_attempts` 保留九十天
- 原始模型响应、完整堆栈、完整 stderr 和其他大体积诊断载荷默认保留七天
- 清理 Attempt 或大体积载荷后，Job 仍保留累计尝试次数、最后处理时间、最后成功时间和最后错误摘要
- 后台清理任务按保留期删除，不影响当前有效评估和 Entry 可读性

## API 改造

自有权威服务需要增加：

- Action 中的 `evaluate` 配置
- 创建和消费 Processing Job
- 查询 Entry Evaluation
- 查询处理状态和失败摘要
- 单条 Entry 重试
- 用户画像与 Taxonomy 快照管理
- 按评估分数、分类和处理状态筛选 Entry
- 精选时间线查询

客户端本地 SQLite 只增加相应缓存投影，不作为评估或 Job 的权威存储。

未来若重新启用 FOLO 官方 AI 等生成能力，服务端适配器也必须先把返回内容转换为本应用内部结果，再按本应用的数据契约保存。当前初始方案中的 AI 推理全部由自有后端完成。

本应用新增能力使用独立扩展命名空间，不修改 FOLO 官方兼容响应：

- `/api/extensions/entries/:entryId/evaluation`
- `/api/extensions/entries/:entryId/processing-status`
- `/api/extensions/entries/projections`
- `/api/extensions/processing/jobs`
- `/api/extensions/processing/jobs/:jobId/retry`
- `/api/extensions/subscriptions/:subscriptionId/acquisition`
- `/api/extensions/subscriptions/:subscriptionId/acquisition/diagnostics`
- `/api/extensions/profiles`
- `/api/extensions/taxonomies`
- `/api/extensions/processing/re-evaluation-preview`
- `/api/extensions/processing/re-evaluation-jobs`

客户端先通过 FOLO 兼容接口读取 Feed、Subscription 和 Entry，再通过扩展接口组合评估、处理和获取诊断。扩展接口独立版本化，不要求 `@follow-app/client-sdk` 理解本应用新增字段。

时间线不得对每个 Entry 分别请求扩展数据。客户端按当前页 Entry ID 调用批量投影接口：

```http
POST /api/extensions/entries/projections
```

```json
{
  "entry_ids": ["entry-1", "entry-2"],
  "include": ["evaluation", "processing_status"]
}
```

- 单次最多接收 100 个 Entry ID
- 响应按 Entry ID 返回评估摘要和处理状态；不存在的数据明确返回空状态
- 时间线每页只发起一次批量请求
- Entry 详情页可以继续使用单条评估和处理状态接口
- 客户端将批量结果写入本地 SQLite 投影和内存 Store，离线时可展示最后同步结果
- 批量接口只返回列表展示必需字段；推荐理由全文、处理尝试和错误详情由单条接口加载

首期扩展投影更新使用按需轮询：

- 当前可见页面存在 `queued` 或 `running` Entry 时，每五秒重新请求当前页批量投影
- 页面或应用失焦后停止轮询
- 页面重新获得焦点时立即刷新一次
- 当前页所有处理状态进入 `succeeded`、`failed` 或其他终态后停止轮询
- 网络错误使用退避，不因一次刷新失败改变 Processing Job 状态
- 后续需要跨设备即时更新时，可以增加 SSE 投影失效事件；首期不引入 WebSocket

## FOLO API 兼容与能力路由

### 对客户端提供兼容门面

客户端默认只配置一个 API 基址，始终连接自有服务。自有服务对 FOLO 客户端暴露与当前固定版本 `@follow-app/client-sdk` 兼容的路径、请求、响应、错误和流式格式；内部再按能力选择本地实现或 FOLO 官方能力适配器。

不建议让业务组件分别持有“本地 FollowClient”和“官方 FollowClient”。这会把鉴权、资源身份、故障回退和数据所有权判断扩散到桌面、Web、移动端的每个调用点。

兼容目标是“客户端实际使用的 API 子集”，而不是一次性复刻全部官方后端。SDK 版本应固定升级，并为已支持接口建立契约测试。

兼容门面采用按需实现：

- 只实现本应用前端实际调用的 FOLO API，以及官方能力适配器建立影子订阅、读取 Feed/Entry 和管理官方连接所必需的接口
- 每个兼容接口都登记支持状态、实现提供方和契约测试
- 未实现接口统一返回 HTTP `501` 和稳定错误码 `capability_not_implemented`
- 客户端在调用前以能力清单决定是否显示入口；`501` 是防御性兜底，不作为正常功能探测
- 不为尚未启用的官方 AI、社交、分享、支付或社区功能预先复制后端实现
- 新的前端调用加入兼容子集前，必须先补充服务端实现和契约测试
- Entry Evaluation、Processing Job、用户画像、Taxonomy 和获取诊断使用独立 `/api/extensions` 命名空间
- 官方兼容的 Feed、Subscription 和 Entry 响应不增加本应用私有字段
- 前端通过组合查询和本地投影把官方兼容资源与扩展资源关联
- 扩展 API 使用自己的契约版本，不与 Client SDK 版本强耦合

版本和升级策略：

- `@follow-app/client-sdk`、客户端提交版本和官方适配器协议版本全部固定到已验证组合
- 禁止依赖范围自动升级到官方最新版
- 每次升级由人工发起，先在隔离环境运行请求/响应契约测试、流式格式测试、鉴权测试、适配器回归测试和数据库兼容检查
- 升级验证必须覆盖当前实际启用的官方能力，以及本地兼容门面中前端正在调用的接口
- 验证通过后再提升版本，并保留回滚到上一已验证组合的能力
- 官方接口发生未预期变化时，只熔断受影响的官方能力并显示不可用状态；自有 Feed、AI、Action、同步和既有内容继续运行
- 服务端能力清单应返回当前兼容版本和各项官方能力健康状态，便于客户端隐藏或禁用受影响入口

### 能力提供方

每项能力声明一个提供方和可用状态：

- `local`：完全由自有服务实现
- `official`：由 FOLO 官方能力适配器调用
- `local_then_official`：本地不可用时可以调用官方
- `official_then_local`：官方限流、不可用或不满足资源条件时回退本地
- `unavailable`：客户端隐藏或禁用该功能

阶段 1-4 只允许使用 `local` 或 `unavailable`；`official`、`local_then_official` 和 `official_then_local` 只在阶段 5 官方能力适配完成后逐项启用。

服务端通过能力清单告诉客户端当前可用功能、提供方、是否需要关联官方账号，以及是否要求存在官方资源 ID。客户端根据能力清单展示功能，不根据支付状态或 HTTP 错误猜测后端能力。

### 路由约束

以下权威写操作固定走自有服务，不自动转发、回退或双写：

- 认证和所有者会话
- Feed、Subscription 和 Entry 主数据
- 已读状态、收藏、Category、List 和 Action
- Entry Evaluation
- Processing Job、用户画像和 Taxonomy

以下无副作用或生成型能力可以按策略路由：

- 摘要
- 翻译
- Readability
- Feed 发现和元数据补全
- 其他不改变权威资源身份的 AI 能力

自动回退只适用于幂等读取或生成型操作。任何会改变权威状态的请求必须拥有唯一目标后端，不能在超时后向另一个后端重试。

### 鉴权与资源身份

自有服务会话和 FOLO 官方账号是两个独立身份。客户端只使用自有服务会话；用户可另外关联 FOLO 官方账号，由服务端安全保存官方凭据并供适配器使用。自有会话 Cookie 或 Token 不转发给官方后端。

官方账号关联的凭据策略：

- 优先使用 FOLO 官方明确提供、可撤销且适合后台任务的长期 Token 或 API Token
- 长期 Token 只保存在服务端凭据库，静态加密，API 和日志不得返回明文
- 若官方暂时只支持会话 Cookie，Cookie 只能作为兼容凭据，必须记录获得时间、最近验证时间和可确认的过期时间
- 系统不得自动读取或上传浏览器中的 FOLO Cookie；用户必须显式完成关联或粘贴授权结果
- 后台任务调用前按需验证凭据，授权失效后进入官方授权恢复窗口，并要求用户重新关联
- 撤销官方账号关联时立即停止所有官方调用；已有官方影子订阅按各自的七天待删除规则处理
- 凭据轮换不改变本地 Feed、Subscription、Entry 或外部资源映射身份

部分官方能力只接收官方 `entryId`，并不接收正文。为此需要保存可选的外部资源映射：

- `provider`
- `resource_type`
- `local_resource_id`
- `external_resource_id`
- `provider_account_id`
- `linked_at`

没有官方资源映射时，这类能力不能仅靠 API 路径兼容直接调用官方。此时只能使用本地实现、调用支持正文输入的官方接口，或在用户明确允许后建立官方资源副本。

对于明确选择 `folo_official` 获取提供方的 Feed，允许在关联的 FOLO 官方账号中创建官方影子订阅。授权粒度为单个 Feed，不提供默认全量同步，也不上传其他本地订阅、已读状态、收藏、Action、处理结果、用户画像或 Taxonomy。

本地 Subscription 仍是用户配置主数据；官方影子订阅只用于让官方完成 RSSHub 路由解析、托管轮询、缓存和 Entry 获取。创建结果必须写入外部资源映射，并向用户显示该 Feed 正在使用 FOLO 官方获取。

### 结果归一化与追溯

无论结果由本地还是官方生成，都先转换为本应用内部格式，再写入自有服务。摘要、翻译、Readability 和评估结果至少记录：

- `provider`
- `processor` 或模型标识（可获得时）
- `provider_resource_id`（存在时）
- `generated_at`
- `request_contract_version`

官方限流、套餐限制、接口变化或服务不可用不得破坏权威数据。官方免费能力属于可替换的机会型提供方，不作为核心功能可用性的永久保证。

### 官方能力清单

需要区分“FOLO 产品具备的能力”和“FOLO 对外稳定开放的 API”。开源客户端可以确认调用形态，但不能据此假定官方承诺第三方长期使用全部接口。

| 官方能力            | 代码中可确认的形态                         | 借用价值   | 设计结论                                                 |
| ------------------- | ------------------------------------------ | ---------- | -------------------------------------------------------- |
| RSSHub 路由目录     | `discover.rsshub`、路由详情和使用热度      | 高         | 可用于搜索、参数表单、预览和路由发现                     |
| FOLO 内建 RSSHub    | 官方订阅可选择内建实例，也支持登记自建实例 | 高         | 视为托管 Feed 获取能力，不假定存在通用裸 RSSHub 代理 API |
| Twitter/X 获取      | `rsshub://twitter/user/...` 路由           | 高         | 属于 RSSHub 能力，不单独建 Twitter 官方适配器            |
| Telegram 获取       | `rsshub://telegram/channel/...` 路由       | 高         | 属于 RSSHub 能力，不单独建 Telegram 官方适配器           |
| Feed 发现与预览     | `discover.discover`、`feeds.get`           | 中高       | 可补充 URL 自动识别、Feed 元数据和预览                   |
| 托管轮询与缓存      | 官方服务持续维护 Feed 和 Entry             | 高         | 只有官方持有对应 Feed/Subscription 时才能间接受益        |
| 反爬与路由维护      | 体现为官方 RSSHub/Feed 获取成功率          | 高但不透明 | 不是独立稳定 API；只能作为托管获取提供方的内部能力       |
| Feed 热度和统计     | 订阅数、更新频率、RSSHub Analytics         | 中         | 用于发现排序，不进入本地评估分                           |
| AI 摘要、翻译、排序 | 官方 AI 接口                               | 当前低     | 初始阶段全部使用自有后端                                 |
| Action 执行         | 官方 Action 接口                           | 当前低     | 自有后端权威执行                                         |
| 跨设备同步          | 官方订阅和阅读状态同步                     | 当前低     | 自有后端权威同步                                         |

Twitter、Telegram 和部分反爬能力并非三个独立 API 产品，而是 RSSHub 路由、官方托管轮询和维护投入共同形成的 Feed 获取能力。它们应共享同一个官方 Feed 获取适配器、状态模型和降级机制。

### 推荐数据流

```text
FOLO 前端
  -> 自有 FOLO API 兼容门面
      -> 自有 Feed、Entry、AI、Action、同步与评估服务
      -> Feed 获取提供方网关
          -> FOLO 官方 API / 官方托管 RSSHub
          -> 自建 RSSHub
          -> 标准 RSS/Atom 直连
```

前端不直接调用官方 API。自有后端负责：

1. 选择 Feed 获取提供方
2. 使用独立的官方账号关联凭据调用官方
3. 将官方 Feed 和 Entry 转换为内部 Feed 契约
4. 分配稳定的本地 ID，并保存外部资源映射
5. 按外部 Entry ID、GUID 和 URL 信号进行幂等导入
6. 保存拉取游标、最后成功时间、配额状态和错误摘要
7. 再由本地 Action、AI 处理流水线和同步服务处理

官方后端只参与获取它负责的来源内容。本地已读状态、收藏、分类、Action、评估结果、用户画像和 Taxonomy 不回传官方。

### Feed 获取提供方配置

一个 Feed 订阅可以声明获取策略，例如：

```yaml
acquisition:
  preferred: folo_official
  fallbacks:
    - self_hosted_rsshub
  input: rsshub://twitter/user/example
```

建议为有状态的官方获取保存：

- `local_subscription_id`
- `provider`
- `provider_account_id`
- `external_feed_id`
- `external_subscription_id`
- `input`
- `cursor`
- `status`
- `quota_state`
- `last_success_at`
- `last_error_summary`
- `active_provider`
- `preferred_provider`
- `degraded_at`
- `degraded_reason`
- `consecutive_failure_count`
- `first_failure_at`
- `last_failure_at`
- `auth_recovery_deadline`

这些字段描述外部获取关系，不取代本地 Feed 和 Subscription 主键。

从 RSSHub 发现页选择路由时，默认提供方按以下顺序决定：

1. 已配置可用的自建 RSSHub：默认选择自建实例
2. 未配置自建实例，但已关联 FOLO 官方账号：推荐 FOLO 官方托管获取，并要求用户对当前 Feed 明确确认官方获取授权
3. 两者都不可用：仍允许保存本地 Feed 订阅，但状态显示为“尚无可用获取提供方”

发现页不得静默创建官方影子订阅。界面应在确认前说明：该 Feed 及官方获取到的 Entry 会保存到关联的 FOLO 官方账号，但本地阅读状态、Action、评估结果和用户画像不会上传。

### 官方能力不可用时

- 已导入 Entry 保持可读，不删除、不回滚
- Feed 标记为获取降级或获取失败，并保留最后成功时间
- 按退避策略重试，不阻塞其他 Feed
- 只有用户预先配置了等价自建 RSSHub 或其他候选提供方时，才允许自动切换
- 自动切换后标记为 `degraded`，记录原提供方、当前提供方、切换原因和切换时间
- 降级具有粘性：官方恢复后不自动切回，避免重复 Entry、游标错位和提供方来回抖动
- 用户可以显式测试官方连接，并手动切回官方获取
- 没有替代通路时停止更新该 Feed，但 AI、Action、阅读和同步能力继续工作
- 配额和套餐限制作为提供方状态返回，不改变本地订阅所有权

自动降级按错误类型触发：

- `unsupported_route`、明确的订阅配额拒绝或其他不可重试的能力拒绝：立即切换到预配置候选提供方
- 超时、限流、网络错误和官方 `5xx`：连续失败至少三次，并且首次到末次失败跨越至少三十分钟后降级
- 官方账号授权失效：立即暂停官方获取并通知用户，给予二十四小时恢复窗口；到期仍未恢复时，仅对存在候选提供方的 Feed 执行降级
- 输入参数错误、本地配置错误或候选提供方自身不可用：不自动降级，要求用户修正

每次成功获取都会清零暂时错误的连续失败计数。错误分类、失败计数、首次失败时间、最近失败时间和授权恢复期限由后端保存，前端不自行计算降级条件。

### 提供方切换与 Entry 去重

切换 Feed 获取提供方不创建新的本地 Subscription，也不改变既有 Subscription ID。系统保留原获取关系作为历史记录，为新的活动提供方建立独立外部资源映射。

切换完成后，新提供方重叠拉取最近七天内容，以覆盖不同提供方的游标和缓存差异。导入时在同一本地 Subscription 内按以下顺序判断：

1. 稳定 GUID 相同：确认是同一个 Entry
2. canonical URL 与发布时间同时相同：确认是同一个 Entry
3. 标题、发布时间和正文指纹相似：只标记为跨提供方重复候选，不自动合并

确认相同后复用既有本地 Entry ID，并把新提供方 Entry ID 添加到该 Entry 的外部资源映射。不能可靠确认时保留两条 Entry，并记录重复候选关系，避免把真正的新消息吞掉。

提供方专有 Entry ID 不能作为本地主键，也不能因提供方切换而替换本地 Entry ID。七天重叠窗口只用于切换和恢复，不改变正常轮询游标。

确认是同一 Entry 后，既有发布内容保持不可变：

- 新提供方只能补齐既有 Entry 中为空的标题、正文、描述、作者或媒体字段
- 已有非空字段不因新提供方内容更完整或不同而覆盖
- 每个补齐字段记录来源提供方和补齐时间
- 非空字段发生实质差异时，保留首次导入值，并把双方值、来源和发现时间记录到诊断元数据
- 内容冲突不创建新的 Entry，也不自动触发重新评估；只有实际导入了新的发布消息才产生新 Entry

建议补充：

- `entry_provider_mappings`
  - `entry_id`
  - `provider`
  - `provider_entry_id`
  - `provider_feed_id`
  - `first_seen_at`
  - `last_seen_at`
- `entry_duplicate_candidates`
  - `entry_id`
  - `candidate_entry_id`
  - `signals_json`
  - `created_at`
- `entry_provider_conflicts`
  - `entry_id`
  - `field`
  - `kept_provider`
  - `kept_value_hash`
  - `conflicting_provider`
  - `conflicting_value_hash`
  - `detected_at`

### 官方影子订阅生命周期

创建官方影子订阅采用本地优先的异步流程：

1. 先提交并保存本地 Feed 和 Subscription
2. 将官方获取关系记录为 `pending`
3. 提交后台任务创建官方影子订阅
4. 创建成功后保存外部 Feed、Subscription 映射并标记为 `active`
5. 创建失败时保留本地订阅，标记为 `failed`，保存错误摘要和下一次重试时间

官方影子订阅创建不参与本地订阅保存事务。前端应立即显示已经保存的本地订阅，并单独展示“正在连接 FOLO 官方获取”或“官方获取连接失败”；用户可以重试或切换其他获取提供方。

当用户取消本地订阅、切换到其他 Feed 获取提供方或撤销官方获取授权时：

1. 立即停止通过该官方影子订阅获取新内容
2. 将影子关系标记为 `pending_deletion`
3. 设置七天后的 `delete_after`
4. 七天内恢复授权或重新选择官方获取时，取消待删除并复用原影子订阅
5. 七天后由后台清理任务删除官方影子订阅，并删除本地外部资源映射

已经导入自有服务的 Entry、处理结果和阅读状态不随影子订阅删除。官方删除失败时保留清理任务、错误摘要和下一次重试时间，不重新启用该获取关系。

影子关系至少补充：

- `status`
- `created_at`
- `activated_at`
- `last_creation_error`
- `next_creation_retry_at`
- `disabled_at`
- `delete_after`
- `deleted_at`
- `last_cleanup_error`
- `next_cleanup_retry_at`

## UI 改造

### Action 设置

- 增加“执行条目评估”
- 选择处理器、用户画像和分类规则
- 可配置优先级

### 时间线和阅读页

- 显示综合分
- 精选按带时间衰减的 `ranking_score` 排序，同时继续展示原始综合分
- 重评成功后如果综合分低于精选候选门槛，该 Entry 从精选中退出；用户需要恢复旧结果时走评估历史回滚
- 显示推荐理由
- 显示 Entry Evaluation 的一级、二级分类和评估标签
- 增加精选视图
- 支持按评分、Entry 内容分类和处理异常筛选
- 支持按评估标签筛选时，筛选对象是当前评估的 `tags_json`，不是 FOLO List、FOLO Category 或未来的用户条目标注
- 配置过期评估继续正常展示和参与精选，并显示轻量“旧配置”标识
- 支持只查看旧配置评估并发起范围重评

### 处理状态

- 显示 queued、running、failed、succeeded；`superseded` 作为内部终态进入详情或诊断，不作为普通卡片主状态
- 显示简短错误摘要
- 重评失败时，卡片仍展示原当前评估；处理状态区域显示失败摘要和重试入口
- 支持单条重试
- 提供失败条目入口

### Feed 获取状态

采用渐进披露，不把提供方运维信息塞入普通 Entry 卡片：

- 正常订阅：订阅列表只显示小型获取来源标签，例如“FOLO 官方”“自建 RSSHub”或“直接 RSS”
- `degraded`、`paused`、授权失效和连接失败：订阅项显示明显状态、简短原因和处理入口
- 订阅详情增加“获取诊断”，展示活动/首选提供方、影子订阅状态、失败计数、最后成功时间、降级原因和手动切回入口
- 外部资源 ID、游标、映射记录、重复候选和字段冲突只在获取诊断的高级区域展示
- 普通时间线和 Entry 阅读页不显示影子订阅、提供方失败次数或重复诊断信息
- 全局只在存在需要用户处理的授权失效、持续失败或降级异常时显示聚合提示

### AI 设置

- 管理用户画像
- 管理 Taxonomy
- 显示处理器与评分公式版本

## 与现有 FOLO 数据的关系

- `entries.settings` 是 Action 对 Entry 生效后的行为指令或开关，例如 `summary`、`translation`；它不是 AI 产物存储
- FOLO Category 只作为 Feed 或 Subscription 的订阅组织分类；Entry Evaluation 的 `primary_category` 和 `secondary_category` 不回写到 FOLO Category
- FOLO List 保持用户显式阅读集合语义；Entry Evaluation 的 `tags_json` 不自动创建、加入或移除 FOLO List
- `entry_evaluations.tags_json` 是处理器生成的不可变评估标签；用户条目标注首期不实现，后续应放在独立存储中，不改写评估历史
- FOLO 客户端调用官方 `ai.summary` 后，将返回内容缓存到本地 `summaries`，按 `(entry_id, language)` 区分普通正文摘要与 Readability 摘要
- 自有评估处理器附带生成的摘要也写入 `summaries`，复用 FOLO 原有摘要展示；`entry_evaluations` 只保存评分、推荐理由、分类、标签、处理器版本、评分公式版本、画像和 Taxonomy 追溯信息
- FOLO 客户端调用官方 `ai.translationBatch` 后，将返回内容缓存到本地 `translations`，按 `(entry_id, language)` 保存标题、描述、正文和 Readability 正文翻译
- Readability 正文直接缓存到 `entries.readabilityContent`
- 开源客户端能够确认摘要和翻译在官方 API 中生成、在本地 SQLite 中缓存；无法从该仓库确认官方服务端是否另有长期结果表
- `aiSort` 只是发送给官方 Entry 列表 API 的查询参数；客户端没有接收或保存可解释的评分字段，因此官方排序分数属于不透明的服务端能力
- 自有服务中的 `entry_evaluations` 保存用于排序、筛选和推荐解释的结构化评估，并向客户端同步缓存投影
- `processing_jobs` 与 `processing_attempts` 保存可靠执行状态
- AI Chat 和 AI Task 报告保持独立

## 推荐的数据归属

| 数据                                                   | 权威存储                                           | FOLO 客户端本地存储                           |
| ------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| Entry 原始字段与阅读状态                               | 自有服务                                           | `entries` 缓存投影                            |
| Action 生效指令                                        | 自有服务                                           | `entries.settings` 缓存投影                   |
| 摘要、翻译、Readability                                | 自有服务；可调用官方 API 生成                      | `summaries`、`translations` 或 Entry 字段缓存 |
| 重要性、时效性、相关性、综合分与推荐理由               | 自有服务 `entry_evaluations`                       | 可重建的评估投影                              |
| Entry 内容分类、评估标签、画像快照与 Taxonomy 快照引用 | 自有服务 `entry_evaluations`                       | 展示所需投影                                  |
| 用户条目标注                                           | 后续自有服务独立存储；首期不实现                   | 后续可重建的用户标注投影                      |
| 排队、运行、失败、重试和错误摘要                       | 自有服务 `processing_jobs` / `processing_attempts` | 状态投影，不作为权威                          |

## 阶段化能力路由建议

### 阶段 1-4：自有核心默认路由

| 能力                                | 权威/提供方        | 说明                                                                 |
| ----------------------------------- | ------------------ | -------------------------------------------------------------------- |
| Feed、Subscription、Entry、阅读状态 | `local`            | 不发送到官方，不双写                                                 |
| Action                              | `local`            | 保持客户端协议兼容，增加 `evaluate`                                  |
| Entry Evaluation 与 Processing Job  | `local`            | 本应用新增能力                                                       |
| 标准 RSS/Atom 获取                  | `local`            | 自有后端直接轮询                                                     |
| Summary、Translation 与其他 AI 推理 | `local`            | 不依赖官方额度或 Entry 映射                                          |
| Readability                         | `local`            | 必要时未来再增加提供方                                               |
| AI Sort                             | `local`            | 使用可解释的 `entry_evaluations.overall_score`，不依赖官方不透明排序 |
| 同步服务                            | `local`            | 自有服务保存订阅、阅读状态与处理结果                                 |
| AI Chat、AI Task、MCP               | `local` 或逐项实现 | 不透明代理官方不是初始目标                                           |

### 阶段 5：官方能力可选路由

| 能力                         | 权威/提供方                 | 说明                                                         |
| ---------------------------- | --------------------------- | ------------------------------------------------------------ |
| RSSHub 路由目录与参数        | `official_then_local_cache` | 官方可用时复用发现数据，本地缓存路由元数据                   |
| RSSHub 托管获取              | `official_then_self_hosted` | 只对明确选择官方提供方并授权的 Feed 生效                     |
| Twitter/X 获取               | `official_then_self_hosted` | 通过 RSSHub 路由，不设计独立 Twitter 数据模型                |
| Telegram 获取                | `official_then_self_hosted` | 通过 RSSHub 路由，不设计独立 Telegram 数据模型               |
| 托管反爬和轮询维护           | `official_optional`         | 作为官方托管获取的内部能力，不承诺独立调用                   |
| 官方摘要、翻译或 Readability | `disabled_by_default`       | 后续逐项评估；启用前必须转换为本应用内部结果并按自有契约保存 |
