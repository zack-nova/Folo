---
status: accepted
---

# 评估时顺带写总结，阅读时只读缓存

## 背景

评估的输出结构从阶段 2 起就有 `summary` 字段，模型每评一条都会写一句总结，服务端存成
`entry_summaries(language='auto')`。客户端按具体语言（如 `zh-CN`）请求 `GET /ai/summary`，主键对不上，所以这些
总结从没被用上；打开每篇文章（包括放在文章视图里的推文）时又单独调一次 Codex 生成，一次约 1.2 万的固定开销、
等十几秒到几十秒，也占每日调用额度。评估规则不覆盖的订阅（例如 `国际局势·快讯流`）在浏览时同样会触发生成。
分析和数字见 `../ai-evaluation-and-summary-analysis.md`。

## 决策

### 评估时按长度写总结

- 评估提示词要求 `summary` 用所有者的语言写。每条请求带 `summary_length`：去标记后正文不少于
  `PROCESSING_SUMMARY_FULL_MIN_CHARS`（默认 500）字符为 `full`（2–4 句），否则为 `brief`（一句）。长短由服务端
  决定，不交给模型判断。
- 总结语言放在 system 前缀的配置里（`summary_language`），同一所有者的前缀仍然字节相同。语言取所有者同步到
  服务端的客户端设置：`actionLanguage` 不是 `default` 时用它，否则用 `language`，都没有时用
  `PROCESSING_SUMMARY_LANGUAGE`（默认 `zh-CN`），与客户端请求时的取法一致。
- 总结按该语言写入 `entry_summaries(entry_id, 语言, 'content')`，只在不存在时写入，不覆盖所有者已经生成的总结。
  评估记录的 `details.summary` 记下语言和长短。
- `processorVersion` 不变：打分语义没有改变，改版本号会让全部现有评估显示为配置过期。
- `PROCESSING_SUMMARIES=false` 时提示词里没有 `summary`，评估不写总结。

### 阅读时只读缓存，生成要所有者点

- `GET /ai/summary` 增加 `cached_only=1`：只查缓存，没有就返回 `data: null`，不调用模型。
- 客户端在"自动 AI 总结"设置下用 `cached_only` 预取：有总结就显示，没有就显示"生成 AI 总结"按钮，点了才生成。
  订阅源的 Action 打开了总结、或者所有者用命令临时打开时，仍然直接生成，因为这是所有者明确要的。
- 旧的 `auto` 总结只在条目是短文、文字与请求语言相符（中文含汉字且无假名、日文含假名、英文两者都没有）时
  复用，并复制到请求语言下；长文等完整总结。
- `/metrics` 增加 `folo_ai_summaries_total{source}`：评估写入的 `evaluation_full`、`evaluation_brief`，以及请求的
  `cached`、`legacy`、`on_demand`、`cache_miss`。

## 未采用的方案

- **评估时一律写完整总结：** 短推文和快讯占多数，完整总结的输出大多没人看；按 token 计费的提供方下比按需更贵。
- **只修语言标记、沿用一句话总结：** 长文仍然只有一句话，打开后多数还是要等完整总结。
- **按分数挑选：** 分数和总结在同一次调用里产生，后端无法提前判断；让模型按自己打的分决定写不写，可能反过来
  影响打分。以后需要时可以评估完再为高分条目另排总结作业。
- **完全手动、不在评估里写总结：** 失去"打开就有"的体验，而评估本来就在写总结。

## 影响

- 评估过的条目打开时总结已经在缓存里，不再单独调 Codex；评估规则不覆盖的条目只在所有者点按钮时生成。
- 每批评估输出变长，长文多约 100–150 token；上线后用评估分数分布对比确认打分没有漂移。
- 客户端没有同步语言设置时，服务端按 `PROCESSING_SUMMARY_LANGUAGE` 写，客户端若请求其他语言会显示按钮。
- 不需要数据库迁移。
