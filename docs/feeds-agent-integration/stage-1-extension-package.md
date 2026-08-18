# 完整阶段一扩展包

> 阶段一已经完成；后续自主 AI 能力见
> [`stage-2-ai-processing-backend.md`](./stage-2-ai-processing-backend.md)。

- 状态：已完成
- 完成日期：2026-08-18
- 前置基线：阶段 0 契约冻结、阶段 1 最小阅读闭环
- 兼容基线：`folo-client-sdk-0.3.95`

## 交付结果

完整阶段一把最小阅读闭环扩展为可迁移、可组织、可恢复的单所有者自托管阅读器：

```text
首个本地账户（实例所有者）
  ├─ RSS/Atom + OPML 导入导出
  ├─ Category + List 组织
  ├─ Profile + Avatar 持久化
  ├─ 时间线 + 已读/收藏
  └─ 安全网页抓取 → Readability → PostgreSQL 缓存
                       └─ 数据库备份 → 隔离恢复演练
```

## 权威边界

- PostgreSQL 新增 `lists`、`list_subscriptions`、`instance_ownership` 和 `entry_readability`。
- Better Auth 的 User 增加 `handle`、`bio`、`website` 和 `socialLinks`；首个账户占有实例，默认拒绝后续注册。
- Category 保持为 Subscription 的可空字符串，避免创建与客户端语义不一致的独立实体。
- Avatar 使用内容签名识别 PNG/JPEG/GIF/WebP、1 MiB 限制和 SHA-256 文件名，文件位于 `UPLOADS_DIRECTORY`。
- Readability 只通过现有安全抓取器访问网页，继续受协议、DNS/私网、重定向、超时和响应体上限约束。

## 本地能力

本阶段新增并宣告：

- `organization.core`
- `subscriptions.opml`
- `profiles.core`

连同最小闭环，Stage 1 本地能力还包括 Auth、Feed、Entry、Read、Collection、Settings 和标准 Feed Discovery。
未宣告的官方能力仍返回阶段 0 冻结的 `501 capability_not_implemented`。

## 验证证据

- 公共 Follow SDK 测试覆盖 Category/List、OPML、Profile/Avatar 和 Readability 缓存。
- 包级测试覆盖无网络 HTML 正文抽取、相对 URL 解析和本地业务 ID 识别。
- PostgreSQL 集成测试执行 Better Auth 与 Drizzle migrations，并跨 Server 实例验证权威数据。
- `pg_dump` custom archive 已通过 `pg_restore --list`，并恢复到隔离数据库；14 张公共表及关键权威表行数一致。
- Playwright 使用真实 Desktop Web 页面完成注册、本地 RSS 订阅、时间线渲染、正文打开和已读/未读往返。

## 明确不在阶段一

- AI 摘要、翻译、评分和对话；这些进入自有 Processing Job/Entry Evaluation 设计。
- 官方 RSSHub、Trending、Billing/Wallet、MCP 和社交关系。
- 多租户角色权限。`ALLOW_PUBLIC_REGISTRATION=true` 仅是开发/测试逃生阀，不等价于多人权限模型。
- 生产部署编排、监控告警、抓取退避和灾备自动化；这些是上线前加固项。

运行、配置、备份和验证命令见 [`apps/server/README.md`](../../apps/server/README.md)。
