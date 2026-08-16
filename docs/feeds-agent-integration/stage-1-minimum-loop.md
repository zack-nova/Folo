# 阶段 1：最小阅读闭环

- 状态：已完成
- 完成日期：2026-08-16
- 兼容基线：`folo-client-sdk-0.3.95`
- 实现位置：`apps/server`

## 交付边界

这一纵向切片让 Desktop/Web 前端只连接自有服务，在不调用 FOLO 官方 API 的情况下完成：

```text
本地账号 → RSS/Atom 预览 → 订阅 → PostgreSQL 权威存储
         → 定时/手动刷新 → 时间线/正文 → 已读/未读/收藏
```

它是“阶段一最小闭环”，不是主方案中“完整阶段一”的全部工作。Category/List、OPML、
Profile/Avatar 和完整网页 Readability 仍属于后续的阶段一扩展包。

## 架构结果

- `apps/server` 是独立 Fastify 进程；FOLO Client SDK 的固定接口由兼容门面实现。
- Better Auth 管理用户、Session、Account 和 Verification 表。
- Drizzle 管理 `feeds`、`entries`、`subscriptions`、`read_states`、`collections` 和 `settings`。
- PostgreSQL 是权威存储；前端现有 SQLite 投影没有被提升为服务端数据库。
- Feed 调度按“去重后的已订阅 Feed”执行，同一 Feed 被多个账号订阅时每轮只拉取一次。
- Feed 和 Entry ID 由规范 URL、GUID/URL/内容信号稳定生成，重复刷新不会产生重复 Entry。
- HTTP fetcher 限制协议、重定向、响应大小和超时，并默认拦截私有网络地址。

## 兼容门面

最小闭环覆盖以下实际路径：

- `/better-auth/*`：注册、登录、会话、登出和 Better Auth 账号接口。
- `/api/extensions/capabilities`、`/status/configs`、`/settings`。
- `/discover`、`/feeds`、`/feeds/refresh`、`/feeds/reset`、`/feeds/analytics`。
- `/subscriptions`、`/subscriptions/batch`。
- `/entries`、`/entries/preview`、`/entries/readability`、`/entries/stream`。
- `/reads`、`/reads/total-count`、`/reads/all`、`/collections`。

未实现路由继续使用阶段 0 冻结的 `501 capability_not_implemented` envelope。能力清单不会宣称
OPML、Organization、RSSHub、Profile、AI、Wallet/Billing 等未交付能力；Desktop 的统一发现页会隐藏对应入口。

## 测试证据

- 使用固定 `FollowClient` SDK 通过 Fastify inject 验证完整阅读闭环，而不是直接调用 Store。
- 使用真实 PostgreSQL 执行 migrations，重建 Server/Store 实例后验证订阅仍然存在。
- RSS fixture 验证正文、附件、排序、新 Entry 导入和重复刷新幂等。
- HTTP fetcher 测试验证内网 SSRF 拦截、大小上限和正常公共 Feed 获取。
- Scheduler 测试验证共享 Feed 在单轮轮询中只刷新一次。
- Desktop capability 单测验证官方旧服务保持兼容、自托管服务隐藏未声明能力。

本地启动、环境变量和数据库命令见 [`apps/server/README.md`](../../apps/server/README.md)。

## 完整阶段一剩余工作

建议按以下顺序补齐：

1. Category/List 的权威表、兼容 API 和前端组织操作。
2. OPML 解析、预览、批量导入、冲突报告和导出。
3. Profile/Avatar 的单人所有者模型，并收紧为“首次初始化后关闭公开注册”。
4. 正文抽取器与可缓存 Readability 结果；RSS 自带全文继续作为零成本优先级。
5. E2E 浏览器回归、备份/恢复、刷新退避、失败诊断和生产部署清单。

上述工作完成后，才应把主方案的阶段一整体状态标记为完成；随后进入 Entry Evaluation 与
Processing Job，而不是提前接入官方 AI 或 RSSHub。
