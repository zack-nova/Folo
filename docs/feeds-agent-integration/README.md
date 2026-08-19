# Feeds Agent × Folo 改造资料

这个目录保存把 Feeds Agent 的 `feed_core` 能力融合到 Folo 里的设计资料。当前方向是：

- 以自有后端作为 Feed、Entry、Action、Entry Evaluation、Processing Job、画像和 Taxonomy 的权威服务。
- Folo 客户端只连接自有服务暴露的 FOLO API 兼容门面。
- Entry 评估、处理作业、精选排序、失败重试和范围重评先由自有服务实现。
- 自建 RSSHub 和后续自主采集能力通过独立 feed-supplier 接入；FOLO 官方 API 仍放在最后作为可选增强。

## 文件

- [folo-integration-plan.md](./folo-integration-plan.md)：主方案，包含阶段路线、数据模型、API 边界、UI 改造和官方能力适配策略。
- [stage-0-contract-freeze.md](./stage-0-contract-freeze.md)：已验证版本组合、实际 API 使用面、能力矩阵、契约样本和变更流程。
- [stage-1-minimum-loop.md](./stage-1-minimum-loop.md)：已完成的自有认证、PostgreSQL、RSS 订阅、阅读状态与收藏最小闭环，以及完整阶段一的剩余边界。
- [stage-2-ai-processing-backend.md](./stage-2-ai-processing-backend.md)：自主 Provider、版本化评估、可靠 Processing Job 与范围重评后端。
- [stage-3-frontend-fusion.md](./stage-3-frontend-fusion.md)：Featured 时间线、评估详情、失败恢复、范围重评和自主 AI 设置的 Folo 前端融合。
- [stage-5a-autonomous-sources.md](./stage-5a-autonomous-sources.md)：自主数据源契约、自建 RSSHub、独立配置库、加密凭据、审计与后续切片。
- [feeds-agent-CONTEXT.md](./feeds-agent-CONTEXT.md)：Feeds Agent 当前领域语言和已解决歧义快照。
- [adr/0012-store-processing-results-by-content-version.md](./adr/0012-store-processing-results-by-content-version.md)：旧处理结果版本化 ADR，已被后续设计取代。
- [adr/0023-split-feed-core-and-supplier-services.md](./adr/0023-split-feed-core-and-supplier-services.md)：feed_core 与 feed_supplier 拆分边界。
- [adr/0024-publish-page-changes-as-new-feed-entries.md](./adr/0024-publish-page-changes-as-new-feed-entries.md)：页面变化作为新 Feed Entry 发布的决策。
- [adr/0025-integrate-autonomous-sources-through-feed-supplier.md](./adr/0025-integrate-autonomous-sources-through-feed-supplier.md)：Folo monorepo 中独立供给服务和自主 RSSHub capability 的实现决策。
- [adr/0026-persist-source-configuration-outside-the-core.md](./adr/0026-persist-source-configuration-outside-the-core.md)：独立来源数据库、密文凭据、管理令牌与哈希链审计决策。
- [adr/0027-materialize-confirmed-page-observations-as-feed-entries.md](./adr/0027-materialize-confirmed-page-observations-as-feed-entries.md)：空基线、去抖确认、不可变页面事件和调度隔离决策。
- [adr/0028-publish-a-self-owned-source-route-catalog.md](./adr/0028-publish-a-self-owned-source-route-catalog.md)：自有路由目录、严格参数 schema、Owner 代理和管理密钥隔离决策。
- [adr/0029-scale-source-acquisition-with-redis.md](./adr/0029-scale-source-acquisition-with-redis.md)：可重建 Redis 缓存、分布式限流/并发租约和失败关闭决策。

## 推荐开发阶段

1. 边界冻结与 Folo 本地可运行。
2. 自有权威后端与最小 FOLO API 兼容门面。
3. Entry Evaluation 与 Processing Job。
4. Folo 前端融合体验。
5. 本地获取与运行稳定化。
6. 自主数据源扩展（阶段 5A）。
7. 官方能力适配（阶段 5B，最后接入）。

详细验收标准见主方案的“开发阶段路线”章节。
