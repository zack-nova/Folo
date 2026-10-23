# AI 评估与 AI 总结能否合并为一次调用（分析）

- 日期：2026-10-22
- 状态：所有者 2026-10-22 选定方案乙，并要求没有缓存时总结改为手动触发；改动清单见第五节，待确认后实现
- 相关：ADR-0012（按内容版本保存处理结果）、ADR-0035（自动评估按批调用）、ADR-0036（每日简报）、
  `stage-2-ai-processing-backend.md`、`folo-integration-plan.md` 第 192、734 行

## 结论先说

评估和总结**已经是同一次调用**：评估的输出结构里一直有 `summary` 字段，模型每评一条都会顺手写一句总结，
服务端也存了。问题是这些总结存成语言 `auto`，客户端按具体语言（如 `zh-CN`）查不到，于是打开文章时又单独
调一次 Codex 重写。也就是说，现在是"顺带总结的钱付了，但没用上，按需总结的钱又付一遍"。

推荐方案乙：评估时**只对长文**顺带写正式总结（服务端按正文长度决定哪些条目要写，写明语言和篇幅），
短文（推文、快讯）保留现在那一句话的总结，改成所有者语言后同样存进总结缓存。这样评估过的条目打开时都不用
再等，多花的输出只在长文上。

## 一、现状

### 评估（打分、推荐理由）

- 触发：服务端后台。新条目按评估规则自动入队，工作线程每 10 条一批调用一次模型（ADR-0035）；所有者手动
  重评和失败重试单条执行。代码在 `apps/server/src/processing/service.ts`。
- 渠道：`AIProviderRouter`（`apps/server/src/ai/router.ts`）。线上 `AI_CODEX_SCOPE=all`，所以自动评估也走
  Codex CLI（模型 `gpt-6.1-sol`，推理强度 `low`，每日调用上限 2000，按调用计数、存在内存里）。没有 Codex 时走
  所有者配置的 OpenAI 兼容 API。
- 提示词：system 是固定指令 + 按键排序的 `{output_schema, profile, taxonomy}`，所有批次前缀字节相同，便于
  提示词缓存；user 是 `{"entries": [{entry_id, entry, source}]}`。条目正文先去掉标记、截到 12000 字符；一批正文
  总量不超过 40000 字符。
- 输出：`importance_score`、`timeliness_score`、`relevance_score`、`recommendation_reason`、`primary_category`、
  `secondary_category`、`tags`，**以及 `summary`**。`output_schema` 里写的是 `"summary": "string"`，没有任何语言
  或篇幅要求；zod 校验里是可选字段。综合分由后端按 0.3/0.2/0.5 计算。
- 存储：评估记录不可变，`details` 里有模型、token 用量和批大小。`summary` 有值时另写一行
  `entry_summaries(entry_id, language='auto', target='content')`，写失败不影响评估。

### 总结（`GET /ai/summary`）

- 触发：客户端按需。桌面端文章布局（`ArticleLayout.tsx`）打开条目时，`<AISummary>` 在"自动 AI 总结"开关打开时
  预取（默认开，`defaultGeneralSettings.summary = true`），或者订阅源的 Action 打开了总结。语言取设置里的
  "操作语言"，默认跟随界面语言，例如 `zh-CN`。移动端 `EntryAISummary` 逻辑相同。
- 推文：详情页布局按订阅的视图选，不按内容类型。OPML 导入不带 `view` 时默认是文章视图（`apps/server/src/opml.ts`），
  所以自托管实例里的 X 订阅走的是文章布局，推文**也有**总结卡片，打开每条推文都会触发一次按需总结。只有放在
  社交媒体视图里的订阅才用 `SocialMediaLayout.tsx`，那里没有总结卡片（原版 Folo 也没有）。
- 渠道：`resolveOwnerAIProvider`，视为所有者发起，Codex 有额度就走 Codex，每次占一次每日额度。
- 提示词：一句话指令（"忠实、简洁地总结，不要编造"）+ `{language, source, title, url}`。`source` 是**未截断、
  未去标记**的原始正文（或 Readability 正文）。
- 缓存：服务端 `entry_summaries` 主键 `(entry_id, language, target)`，同一键并发请求合并为一次；客户端另有本地
  SQLite 缓存。按需路径**不记录 token 用量**。

### 两者为什么没接上

1. 评估写的是 `language='auto'`，按需查的是 `language='zh-CN'` 等，主键对不上，永远未命中。
2. 评估提示词没要求总结用什么语言、写多长，所以即使改成直接复用，可能拿到英文或只有半句的总结。
3. 评估总结只覆盖 `target='content'`；正文只有摘要、需要 Readability 的文章，按需总结仍然要单独生成。

### token 和调用量（线上记录 + 估算）

生产数据库的只读查询在本次会话里被权限拦截，下面的数字来自运维说明和 ADR 里记录的实测，其余是估算。
附录给了一段只读 SQL，所有者自己跑一次就能换成真实数字。

| 项目                          | 数字                                                                     | 来源                                   |
| ----------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| 每天待评估条目                | 约 400–600 条                                                            | ADR-0035（约 600）、ADR-0036（几百条） |
| 其中综合分 ≥70                | 约 80–110 条                                                             | ADR-0036                               |
| 一次合批评估（10 条）         | 输入约 1.8 万（1.2 万命中缓存），输出约 1300                             | 运维说明 2026-10-09 实测               |
| 每条评估分摊                  | 输入约 1800（未命中约 600），输出约 130                                  | 上一行除以 10                          |
| 一次 Codex 单条调用的固定开销 | 约 1.2 万输入（命中缓存）                                                | 运维说明 2026-10-08 实测               |
| 一次按需总结（Codex）         | 输入约 1.3–2 万（1.2 万固定 + 正文），输出约 200–400；等待十几秒到几十秒 | 估算                                   |
| 每天按需总结次数              | 打开的文章和推文都算，估 20–50 次                                        | 估算，待附录 SQL 核实                  |
| 评估里现在白写的总结          | 每条估 30–60 输出 token，每天约 1.5–3.5 万                               | 估算：每条总输出才 130                 |

要点：每条评估总共只有约 130 个输出 token，里面还包括三个分数、推荐理由、分类和标签，所以现在顺带写的
总结很短，大概一句话。

## 二、方案

四个方案都保留 `GET /ai/summary` 作为兜底：评估没覆盖的条目、Readability 正文、其他语言，仍按需生成。

### 甲：评估时一律顺带总结

- 提示词：把 `summary` 从"可选的一句话"改成明确要求，例如"用 `<所有者语言>` 写 2–4 句，100–200 字，只陈述
  正文事实，不重复推荐理由"。语言写进 system 前缀（所有者级别的固定值），不破坏前缀缓存。
- 存储：按所有者语言写 `entry_summaries(entry_id, '<语言>', 'content')`，客户端第一次打开就命中。
- 输出：每条多约 100–150 token，一批从 1300 涨到约 2500–2800。

### 乙：只对长文顺带（推荐）

- 服务端调用前就知道每条正文的长度，在请求里给每条加 `"summarize": true/false`：去标记后正文 ≥ 某个门槛
  （建议 500 字符起，可配置）才为真；模型只为 `true` 的条目写总结，其余省略该字段。门槛由代码决定，不靠模型
  自觉，结果可预期、可测。
- 短推文、通讯社快讯不写长总结：正文本身就两三句，保留现在那一句话的总结即可（改成所有者语言），也存进缓存，
  打开推文时不再单独调 Codex。
- 其余同甲（语言、篇幅要求，按所有者语言存储）。
- 变体乙二：按分数而不是长度挑。分数在同一次调用里才产生，后端没法提前判断；要么让模型按自己打的分决定写
  不写（可能反过来影响打分），要么评估完再为 ≥70 分的条目另排一批"总结作业"（每天约 10 次合批调用，打分提示词
  完全不动，但要在作业系统里加一种新用途）。乙二可以作为乙上线后的第二步，看实际阅读数据再定。

### 丙：维持分开，只修语言让现成总结能复用

- 评估提示词只加一行"summary 用 `<所有者语言>` 写"，其余不变，所以总结仍然很短。
- 存储改为按所有者语言写；旧的 `auto` 行在 `/ai/summary` 未命中时做一次文字检测（请求中文且总结含汉字才用），
  否则照旧按需生成。
- 改动最小，但用户看到的"AI 总结"会是一句话，和按需生成的 3–5 句差距明显；很多文章打开后仍然要等完整总结。

### 丁（对照）：彻底分开

- 从评估输出里去掉 `summary`，省掉现在每天白写的 1.5–3.5 万输出 token；按需总结保持原样。
- 列出来是为了说明"什么都不做"并不等于不花钱。

### 各方案共同要改的地方

- **所有者语言**：服务端现在不知道客户端的"操作语言"。需要一个服务端可读的值：最简单是在 AI 设置（或评估
  画像预设）里加"总结语言"，默认 `zh-CN`。是否能直接读同步上来的客户端设置，实现前再核实。
- **缓存键**：`(entry_id, 语言, 'content')` 不变。评估写入时不覆盖已有的按需总结（按需那份更完整）；条目内容
  变了、重新评估时才覆盖。
- **社交媒体视图（可选）**：现在的 X 订阅在文章视图里，已有总结卡片，不用改。以后如果把订阅移到社交媒体视图，
  再给 `SocialMediaLayout.tsx` 加 `<AISummary>`，只在已有总结或用户手动点开时显示。
- **开关**：服务端一个配置（例如 `PROCESSING_SUMMARY_MODE=off|long|all`，乙默认 `long`）；客户端沿用现有的
  "自动 AI 总结"开关控制显示。
- **可见性**：`/metrics` 增加评估顺带总结的条数和按需总结的调用数（按需路径现在不记 token），上线一周后能比较。

## 三、得失

按每天评估 500 条、打开 30 篇需要总结的文章估算（数量级，不是实测）：

|                    | 甲：一律顺带             | 乙：长文顺带                       | 丙：只修语言           | 丁：彻底分开     |
| ------------------ | ------------------------ | ---------------------------------- | ---------------------- | ---------------- |
| 评估每天多出的输出 | 约 +5–7.5 万             | 约 +1.5–3 万（假设三到四成是长文） | 约 0                   | 约 −1.5–3.5 万   |
| 按需总结调用       | 评估过的条目基本为 0     | 评估过的条目基本为 0               | 少量命中，多数照旧     | 照旧（20–50 次） |
| 省下的 Codex 调用  | 20–50 次/天              | 20–50 次/天                        | 个位数                 | 0                |
| 打开文章时         | 总结已在，不用等         | 都不用等（短文是一句话）           | 多数仍等十几秒到几十秒 | 照旧             |
| 每批评估耗时       | 输出约翻倍，一批明显变慢 | 略慢                               | 不变                   | 略快             |
| 打分质量风险       | 中：提示词多一项任务     | 低到中                             | 低                     | 无               |
| 改动面             | 提示词、存储、语言设置   | 同甲，加长度门槛                   | 一行提示词、存储、回退 | 删字段           |

### 关键权衡

- **Codex 下省的是调用和等待，不是 token。** Codex 按套餐限制调用频率，不按 token 计费；按需总结每次都要付
  1.2 万的固定开销，再占一次额度。把总结并进合批评估，等于把 20–50 次完整代理运行换成几万个分摊在已有调用
  里的输出 token，划算。真正明显的收益是打开文章时不用等。
- **换成按 token 计费的 API 时账就反过来了。** 没有 Codex 的固定开销，一次按需总结只有正文 + 几百输出，
  按输出价约为输入四倍粗算，每次约 3000 等效 token；为每条评估多写 150 输出约 600 等效 token。所有者打开带总结
  的文章少于评估量的大约五分之一时，"一律顺带"比按需更贵。按 500 条打开 30 篇算是 6%，甲在 API 下要多花 2–3 倍，
  乙因为只写长文，差距小得多。
- **不看的文章也付了总结的钱**：这是甲的主要代价。乙只给长文写完整总结，占多数的短推文和快讯沿用一句话；乙二能进一步只给
  高分条目写。
- **打分质量**：评估是温度 0.1、低推理强度的一次输出，多一项写作任务会分走注意力，也让每批 JSON 更长、
  整批解析失败的概率变高（失败的条目会单条重试，不会丢）。上线前用同一批条目对比有无总结时的分数（ADR-0035
  的抽样做法），差异在几分以内才放开。
- **总结的完整度**：评估看到的是去标记、截到 1.2 万字符的正文，超长文章只总结前半部分；按需总结看的是全文。
  对新闻和推文影响不大，对长篇研究报告会差一些，可以在总结卡片上保留"重新生成"走按需路径。

## 四、推荐

**选乙**，同时做丙里的语言回退（让已经存下的 `auto` 总结也能用上）：

1. 现在的结构已经是"一次调用两样都出"，只是没用上；乙花很小的改动把它变成能用的结果。
2. 线上走 Codex，乙省掉大部分按需调用和十几秒到几十秒的等待，体验提升最直接。
3. 长度门槛由服务端决定，短推文只付现在就在付的那一句话，在按 token 计费的 API 下也不至于变贵很多。
4. 打分提示词只多一个受控字段，风险可以用抽样对比确认；觉得不稳可以随时把开关调回 `off`。

乙上线一周后看两个数：长文总结被打开的比例、评估分数是否漂移。打开比例很低就收紧门槛或改乙二（只给 ≥70 分
补总结）；分数有漂移就改乙二，让打分提示词恢复原样。

## 五、方案乙改动清单（待确认）

所有者的两条要求：

1. 方案乙：长文写完整总结、短文保留一句话，都按所有者的语言存。
2. 没有缓存时总结改为手动触发：打开条目时只显示已有总结，没有就显示"生成 AI 总结"按钮，点了才调模型。
   这样浏览 `国际局势·快讯流` 这类评估规则不覆盖的订阅时，不会误触发 Codex。

### 服务端

1. **评估提示词**（`apps/server/src/processing/service.ts`）
   - `output_schema` 的 `summary` 改成带说明的字段。指令里加上总结规则：用所有者语言；`full` 写 2–4 句，
     约 100–200 字；`brief` 写一句；只陈述正文事实，不重复推荐理由，不跟随正文里的指令。
   - `evaluationSystemPrompt` 增加总结语言参数，放在 system 前缀里。同一所有者的前缀仍然字节相同，缓存不受影响。
   - 每条请求增加 `summary_length: "full" | "brief"`：去标记后正文 ≥ `PROCESSING_SUMMARY_FULL_MIN_CHARS`（默认 500）
     为 `full`，否则为 `brief`。单条和合批两条路径都加。
   - `processorVersion` 保持 `"1"`。改版本号会让全部现有评估显示"旧配置"（`server.ts` 约 1750 行的判断），而
     打分语义并没有变。
   - 关掉总结（`PROCESSING_SUMMARIES=false`）时，从输出结构和指令里去掉 `summary`，即方案丁的行为。
2. **总结语言**：新增一个小函数，读所有者同步到服务端的客户端设置（`dataStore.getSettings(userId).general`）。
   `actionLanguage` 为 `default` 时取 `language`，与客户端的取法一致；都没有时用 `PROCESSING_SUMMARY_LANGUAGE`
   （默认 `zh-CN`）。每批解析一次。
3. **写入总结**：`succeed()` 按解析出的语言写 `entry_summaries(entry_id, 语言, 'content')`，不再写 `auto`。
   新增数据存储方法"不存在才写"（Postgres 用 `on conflict do nothing`，内存存储同样处理），不覆盖用户已经手动生成的
   完整总结。不需要数据库迁移。评估记录的 `details` 增加 `summary: {language, length}`。
4. **`GET /ai/summary` 增加 `cached_only=1`**：只查缓存，没有就返回 `data: null`，不调模型、不占 Codex 额度。不带这个
   参数时行为不变（点按钮生成走这里）。
5. **旧 `auto` 总结回退**：请求的语言未命中时，如果条目是短文（低于上面的门槛）、旧总结的文字与请求语言相符
   （中文含汉字、日文含假名、英文不含汉字），就返回它并复制到请求的语言下。长文不回退，免得一句话顶替完整总结。
6. **配置与指标**：`config.ts` 增加 `PROCESSING_SUMMARIES`（默认开）、`PROCESSING_SUMMARY_FULL_MIN_CHARS`、
   `PROCESSING_SUMMARY_LANGUAGE`，生产环境文件经 `env_file` 传入，compose 不用改。`/metrics` 增加
   `folo_ai_summaries_total{source="evaluation_full|evaluation_brief|on_demand|cached|legacy|cache_miss"}`。
7. **测试**（`apps/server/tests/processing.test.ts`、`ai-provider.test.ts`）：提示词包含语言和每条的
   `summary_length`；总结按语言存储且不覆盖已有总结；关闭开关后提示词里没有 `summary`；`cached_only` 不调用
   提供方；旧 `auto` 回退只对短文、语言相符时生效。

### 客户端

8. **总结 store**（`packages/internal/store/src/modules/summary/`）：`generateSummary` 和 `usePrefetchSummary` 增加
   `cachedOnly`。只查缓存的空结果单独记状态，后面点按钮仍能生成。SDK 的 `SummaryRequest` 类型里没有这个参数，
   用带类型的扩展传入，实现时先确认 SDK 会把多出的查询参数原样带上；不行就改为直接请求。
9. **桌面端**（`modules/entry-content/components/AISummary.tsx`）：开着"自动 AI 总结"时只查缓存；有就显示卡片，
   没有就在原位置显示"生成 AI 总结"按钮，点了才生成并显示加载状态。订阅源的 Action 明确打开了总结、或者
   用户用命令临时打开时，照旧直接生成，因为这两种是所有者主动要的。
10. **移动端**（`apps/mobile/src/modules/entry-content/EntryAISummary.tsx`）：同样的逻辑。
11. **文案**：按钮文字加 `en`、`zh-CN`、`ja` 三种语言，桌面端和移动端各自的语言包都加。

### 文档与部署

12. 新写 ADR-0038 记录决定；本文状态改为"已决定"；README 索引和 `stage-2-ai-processing-backend.md` 里关于
    总结缓存的一句同步修改。
13. 部署：核心重新部署、网页版重新构建，不需要迁移。验证四件事：
    - 新一批评估后，`entry_summaries` 里出现 `zh-CN` 行，长文的总结明显更长。
    - 打开一篇已评估的长文，总结立刻显示。
    - 打开快讯流里的一条，只显示按钮，`/metrics` 里 `cache_miss` 加一、Codex 调用数不变。
    - 一周后用附录的 SQL 对比上线前后的分数分布，看有没有漂移。
14. 质量门：`pnpm run typecheck`、`pnpm run lint:fix`、`pnpm run test`；运维说明记录新配置项。

## 附录：所有者自己核实数字的只读 SQL

在新加坡节点上运行（只读，不改数据）：

```bash
sudo docker exec -i server-postgres-1 psql -U folo -d folo < summary-usage.sql
```

```sql
-- 总结按语言、目标、模型分组：auto 是评估顺带的，其余是按需生成的
select language, target, model, count(*), round(avg(length(summary))) avg_chars,
  min(created_at)::date first_day, max(created_at)::date last_day
from entry_summaries group by 1, 2, 3 order by 4 desc;

-- 最近 14 天每天的按需总结次数
select created_at::date day, language, count(*) from entry_summaries
where language <> 'auto' and created_at > now() - interval '14 days' group by 1, 2 order by 1;

-- 最近 14 天每天评估了多少条
select processed_at::date day, count(*) from entry_evaluations
where processed_at > now() - interval '14 days' group by 1 order by 1;

-- 按批大小看每次调用的平均 token（单条的批大小记为 1）
select coalesce((execution_metadata->'batch'->>'size')::int, 1) batch_size, count(*) attempts,
  round(avg((execution_metadata->'usage'->>'inputTokens')::numeric)) avg_input,
  round(avg((execution_metadata->'usage'->>'cachedInputTokens')::numeric)) avg_cached,
  round(avg((execution_metadata->'usage'->>'outputTokens')::numeric)) avg_output
from processing_attempts where status = 'succeeded' and finished_at > now() - interval '7 days'
group by 1 order by 1;

-- 评估顺带的总结有多少是中文、平均多长
select count(*) filter (where summary ~ '[一-龥]') chinese, count(*) total,
  round(avg(length(summary))) avg_chars
from entry_summaries where language = 'auto';
```
