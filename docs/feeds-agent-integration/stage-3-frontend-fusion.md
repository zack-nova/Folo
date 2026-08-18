# 阶段三：前端自主化融合

## 结果

阶段三把阶段二的自主 AI 后端直接融合进 Folo 的阅读界面。用户不需要进入另一套管理系统，就能在时间线、
Entry 详情和设置页完成精选阅读、评估筛选、重评、失败恢复与配置管理。Folo 的 Category 和 List 仍只用于
订阅组织；AI 分类与标签只存在于 Entry Evaluation 投影中。

```text
Folo 时间线
  ├─ Featured：后端筛选 overall_score >= 70，并按时间衰减排序
  ├─ 批量投影：当前评估 + 最新处理状态
  ├─ 本地组合筛选：最低分 / 分类 / 标签 / 处理失败
  └─ 范围重评：预览 -> 二次确认 -> 提交统计

Entry 详情
  ├─ 三维评分、综合分、推荐理由、分类、标签、旧配置提示
  ├─ queued / running / failed / succeeded 状态
  ├─ 单条评估、强制重评、失败重试
  └─ 历史评估查看与当前版本回滚

AI 设置
  ├─ OpenAI-compatible Provider / Model / BYOK
  ├─ 版本化 Profile Markdown
  ├─ 版本化 Taxonomy JSON
  └─ 只读处理器与评分公式版本
```

## 能力发现

扩展契约升级为 `feeds-agent-extensions-v3`，能力清单 schema 为 3。自托管后端返回 `stage: 3` 并显式
声明 `entries.ai_fusion`；阶段三界面只有在该能力被声明后才显示，避免在官方后端或旧自托管后端上误发
扩展请求。

阶段三继续使用阶段二的细粒度能力：

- `ai.provider_configuration`：Provider 设置。
- `entries.evaluation_processing`：评估、投影、作业、快照和重评协议。
- `entries.ai_fusion`：时间线与详情页的阶段三前端入口。

## Featured 时间线

用户可以在原时间线标题栏切换 Featured。请求仍使用 Follow Client SDK 的 `entries.list({ aiSort: true })`，
但自托管后端采用本应用定义的精选语义：

- 只返回拥有当前评估且 `overall_score >= 70` 的 Entry。
- `ranking_score = overall_score × 2 ^ (-age_days / half_life_days)`。
- 默认半衰期为 7 天；Taxonomy 可以通过 `default_half_life_days` 或分类配置覆盖。
- 发布时间晚于当前时间超过 24 小时时回退到首次导入时间。
- 按 `ranking_score` 降序，同分按发布时间降序。
- 未评估条目不进入 Featured，普通时间线不受影响。

时间线按最多 100 个 Entry 一批读取扩展投影。列表徽标显示综合分、一级分类、旧配置和处理状态；筛选器
可以组合最低分、分类、标签与失败状态。筛选只作用于当前加载结果，不改变 Category/List 或服务端主数据。

## 评估与故障恢复

Entry 详情页展示当前评估和完整历史。评估事实与作业错误分开呈现：新任务失败时，已有当前评估继续显示，
同时提示失败摘要和重试入口。选择历史版本只移动当前指针，不重新调用 Provider。

时间线存在 queued/running Job 时每 5 秒刷新投影；没有活动 Job 时停止轮询。失败横幅支持查看失败筛选和批量
重试当前可见的失败 Job。应用回到前台时会重新检查状态。

## 范围重评

范围重评从当前 Feed 或 View 创建筛选条件，并执行两步提交：

1. 预览匹配条目、已满足、活动作业和预计 Provider 调用数。
2. 用户确认后提交，展示 `created`、`reused`、`already_satisfied`、`superseded` 和 `skipped` 统计。

`force_rerun` 默认关闭。开启后，同配置已有评估的 Entry 也会创建新任务和新评估历史。

## 配置安全边界

- API Key 只在保存时从表单发送；后端后续只返回配置来源和末四位提示。
- 删除数据库 BYOK 后回退到服务器环境 Provider。
- Profile 与 Taxonomy 保存为不可变快照；设置页展示历史数量与当前版本。
- 处理器 `personal-relevance / v1` 和公式 `weighted-v1` 在阶段三只读，公式权重为 30% / 20% / 50%。
- 前端不把画像、Taxonomy、AI 标签或分类写入 Folo Category/List。

## 验收与回归

阶段三的自动化覆盖：

- 能力清单 v3 和仅显式声明的扩展能力门控。
- API 客户端 100 条批量分片及错误恢复文案。
- 评分、分类、标签、失败状态的组合筛选和活动任务轮询条件。
- 当前评估与失败 Job 并存的展示模型。
- Featured 阈值与未评估条目排除。
- 浏览器自托管闭环中可见 Entry AI 评估面板。

阶段四再处理长期运行所需的高负载分页基准、完整可观测性、告警和生产部署回滚；这些不改变阶段三已经
冻结的前端交互与扩展协议。
