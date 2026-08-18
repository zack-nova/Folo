# 阶段二：自主 AI 处理后端

> 后续前端融合、Featured 时间线和设置体验见
> [`stage-3-frontend-fusion.md`](./stage-3-frontend-fusion.md)。

## 结果

阶段二把摘要、翻译和逐条评估从 Folo 官方服务迁回自有后端。应用所有者控制 Provider、模型、Key、
用户画像、Taxonomy 和重评策略；PostgreSQL 保存全部权威配置、执行历史和结果。

```text
RSS / Atom Entry
  ├─ Action evaluate ─┐
  ├─ 手动单条任务 ───┼─> Processing Job -> Attempt -> OpenAI-compatible Provider
  └─ 批量范围重评 ───┘                         |
                                      Entry Evaluation + optional Summary
                                                 |
                                      Current Evaluation pointer
```

## Provider 与密钥边界

- 支持任意实现 `/chat/completions` 的 OpenAI-compatible Provider。
- 可使用服务器环境变量，也可通过 `PUT /api/extensions/ai/provider` 保存实例所有者的 BYOK。
- BYOK 使用 AES-256-GCM 加密，密钥由 `AI_ENCRYPTION_SECRET` 派生；API、日志和错误响应不返回明文 Key。
- 数据库保存 Provider base URL、模型、密文、末四位提示和更新时间。
- 环境配置优先级低于数据库 BYOK；删除数据库配置后自动回退到环境配置。

## 配置快照

- `POST /api/extensions/profiles` 创建不可变用户画像快照。
- `POST /api/extensions/taxonomies` 创建不可变分类快照。
- 同名且内容哈希相同的请求复用既有快照；内容变化会增加版本。
- 新任务默认使用全局最新快照，也可显式指定 `profile_snapshot_id` 和 `taxonomy_snapshot_id`。
- 当前评估引用的快照不是最新快照时，查询返回 `configuration_outdated=true`，但不会自动覆盖旧结果。

## Processing Job

单条创建：

```http
POST /api/extensions/processing/jobs
Content-Type: application/json

{
  "entry_id": "entry_...",
  "force_rerun": false,
  "priority": 0
}
```

幂等键绑定 Entry、内容指纹、处理器版本、评分公式、画像快照和 Taxonomy 快照：

- 已有同配置当前评估：`already_satisfied`。
- 已有相同 `queued/running` Job：`reused`。
- 新配置遇到旧的 queued Job：旧 Job 进入 `superseded`。
- `force_rerun=true` 在没有同配置活动 Job 时创建新的历史评估。
- 同一 Entry 同一目的最多运行一个 Job。

失败按指数退避自动尝试，达到 `PROCESSING_MAX_ATTEMPTS` 后进入 `failed`。人工调用
`POST /api/extensions/processing/jobs/{jobId}/retry` 复用原 Job 并新增 Attempt。失败永远不会清空当前评估。

## 评估结果

AI 返回重要性、时效性、相关性、推荐理由、分类、标签和可选摘要。综合分由后端计算，模型不能直接决定：

```text
overall_score = round(importance × 0.3 + timeliness × 0.2 + relevance × 0.5)
```

每次成功处理新增一条不可变 `entry_evaluations`，并在同一数据库事务内更新
`entry_current_evaluations`、Attempt 和 Job。历史回滚只切换当前指针：

```http
POST /api/extensions/entries/{entryId}/evaluation/{evaluationId}/select
```

批量列表使用 `POST /api/extensions/entries/projections`，单次最多 100 个 Entry，避免时间线 N+1 请求。

## 批量重评

- `POST /api/extensions/processing/re-evaluation-preview` 返回匹配数、已满足数、活动 Job 数和预计调用数。
- `POST /api/extensions/processing/re-evaluation-jobs` 返回 `created/reused/already_satisfied/superseded/skipped` 统计和 Job ID。
- 支持明确 `entry_ids`，或按 Feed、View、发布时间范围筛选；单次最多 1000 个 Entry。

## Follow 兼容 AI

- `GET /ai/summary`：按 Entry、语言、`content/readabilityContent` 缓存。
- `POST /ai/translation/batch`：返回 Follow Client SDK 需要的 NDJSON，按 Entry 和语言缓存字段。
- AI 评估附带摘要时写入独立摘要表，不把摘要塞进评估历史。

## 数据表

- `ai_provider_configs`
- `action_rules`
- `processing_profile_snapshots`
- `processing_taxonomy_snapshots`
- `processing_jobs`
- `processing_attempts`
- `entry_evaluations`
- `entry_current_evaluations`
- `entry_summaries`
- `entry_translations`

迁移文件为 `apps/server/drizzle/0003_motionless_marrow.sql` 和
`apps/server/drizzle/0004_harsh_bulldozer.sql`。备份恢复演练会对比上述权威表与阶段一表的行数；Provider
密文恢复后仍依赖同一 `AI_ENCRYPTION_SECRET`。
