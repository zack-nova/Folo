---
status: superseded by ADR-0024
---

# 按原始内容版本独立存储处理结果

Feeds Agent 的 **处理结果** 保存到独立的 `item_processing_results` SQLite 表，并绑定到 **原始内容版本**，而不是把摘要、评分、AI 识别发布时间、推荐理由和 AI 标签直接加到 **内容索引** `items` 表。这样同一 **内容条目** 的内容变化会自然重新进入 **待处理条目**，回填可以用 `item_id`、`content_version` 和 `content_fingerprint` 做幂等校验；代价是 **内容浏览** 需要 join 处理结果，但避免了 `items` 同时承担索引、版本化判断和 AI 结果主存储三种职责。
