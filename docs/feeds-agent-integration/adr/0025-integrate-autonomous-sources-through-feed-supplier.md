---
status: accepted
---

# 通过独立供给服务接入自主数据源

Folo 单体核心不直接访问 RSSHub 或非 Feed 平台。阶段 5A 在当前 TypeScript monorepo 中增加可独立部署的
`apps/feed-supplier`，主后端只通过带 Bearer 认证的内部 HTTP 接口取得标准 RSS/Atom。RSSHub 路由、
`ACCESS_KEY` 和后续站点凭据属于供给端；核心只保存 `rsshub://` 逻辑来源地址和导入后的不可变 Feed Entry。

本决定保留 ADR-0023 的进程、依赖、配置和运行边界；对于当前 Folo 仓库，以 TypeScript workspace app
取代其中来自原 Feeds Agent 方案的 Python 包和顶层目录细节。阶段 5A.1 允许供给端先使用环境配置完成无状态
最小闭环；独立持久化、加密凭据和调度状态在 5A.2 引入，不得写入核心数据库。

自建能力使用 `sources.rsshub_self_hosted`，不得宣告表示 FOLO 官方接口的 `rsshub.hosted`。这使自主数据源
可以独立上线、禁用和恢复，同时避免现有客户端误调用官方 `discover.rsshub` 或 `rsshub.*` SDK。
