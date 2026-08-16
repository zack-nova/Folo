# 阶段 0：FOLO 契约冻结基线

- 状态：已完成
- 冻结日期：2026-08-16
- 兼容版本：`folo-client-sdk-0.3.95`

## 冻结结果

首期客户端固定在以下已验证组合：

- 上游 `RSSNext/Folo` `dev`：`7c220c69a841defbfeeb00a86ed75ad482b22a57`
- Desktop/Web：`1.12.0`
- `@follow-app/client-sdk`：`0.3.95`
- SDK code hash：`1369189a7ee94768acfc99d1fd8c7a5476e82e94078975a0877f35913ba97911`
- Better Auth / `@better-auth/stripe`：`1.6.23`
- TypeScript：`6.0.3`
- Node.js：`22.22.2`，冻结检查要求 Node.js 22.x
- pnpm：`10.17.0`

机器可读基线位于
[`packages/compat-contracts/contracts/stage-0-baseline.json`](../../packages/compat-contracts/contracts/stage-0-baseline.json)。

本地 SQLite schema 的角色固定为 `rebuildable_cache`。服务端 PostgreSQL 才是阶段 1
开始建设的权威存储；不得把当前 SQLite 表直接提升为服务端主数据。

## 实际 API 使用面

冻结脚本从 SDK 0.3.95 的 module registry 读取路由定义，再通过 TypeScript AST 扫描生产源码和
Better Auth 客户端调用，排除测试、E2E、构建产物和生成目录。当前结果为：

- 98 个实际使用的 SDK 路由；
- 27 个未进入 SDK module registry 的请求，包括 Better Auth 生成式调用和直接 HTTP 请求；
- 每个 SDK 路由记录 API 名、HTTP method、path 参数、显式 query/body 映射、剩余输入落点、
  请求内容类型、响应传输类型和调用点；
- 覆盖 Desktop/Web、共享 Store、Mobile、SSR 和 CLI，首期交付目标仍只包括 Desktop/Web。

SDK 0.3.95 的绝大多数路由依赖代理默认映射：GET 的剩余输入进入 query，其他 HTTP method 的
剩余输入进入 body。因此生成清单中的空 `explicitQueryFields` 或 `explicitBodyFields` 只表示路由
没有覆盖默认映射，不表示请求没有字段。具体输入类型由固定 SDK artifact 和 code hash 锁定；
阶段 1 实现接口时再为兼容子集增加真实请求与响应 fixture。

完整清单位于
[`packages/compat-contracts/contracts/api-usage.generated.json`](../../packages/compat-contracts/contracts/api-usage.generated.json)。
新调用一旦进入生产源码，`pnpm contracts:check` 会失败。

## 首期兼容子集

阶段 1 必须由自有后端本地实现：

- 邮箱密码认证、会话和登出；
- 标准 RSS/Atom 发现；
- Feed 元数据和刷新；
- Subscription 与 OPML；
- Entry 列表、详情、正文流和 Readability；
- 已读、未读、全部已读和未读计数；
- 收藏、Category、List；
- Profile、头像、Settings 和 Status Configs。

阶段 2 再启用 Action、摘要、翻译和 Entry Processing；Inbox、Push、AI Task 等能力在能力清单
声明可用前保持关闭。官方 AI Chat、RSSHub、Trending、MCP、Feed Claim、Wallet、Billing 和官方
Telemetry 首期统一隐藏。

逐项策略位于
[`packages/compat-contracts/contracts/capabilities.json`](../../packages/compat-contracts/contracts/capabilities.json)。
每个实际调用必须且只能归属一个 capability。阶段 1-4 的 provider 只能是 `local` 或
`unavailable`，不得隐式调用 FOLO 官方服务。

## 能力发现与未实现策略

自有后端从阶段 1 起提供：

```http
GET /api/extensions/capabilities
```

该清单同时返回兼容版本 `folo-client-sdk-0.3.95` 和独立扩展契约版本
`feeds-agent-extensions-v1`；扩展 API 升级不得隐式跟随 Client SDK。

客户端只对清单中已 advertised 的 `local` 能力显示入口。`unavailable` 能力必须隐藏；不能用
“先请求、失败后判断”的方式探测能力。

任何遗漏调用的防御性响应固定为 HTTP `501`：

```json
{
  "code": "capability_not_implemented",
  "message": "Capability is not implemented: billing_and_wallet",
  "data": {
    "capability": "billing_and_wallet"
  }
}
```

该错误不用于正常流程，客户端正常情况下应在发出请求前隐藏对应入口。

## 响应与流式契约骨架

兼容 JSON 成功响应保持 SDK envelope：

```json
{
  "code": 0,
  "data": []
}
```

Entry 正文批量流固定为 UTF-8 NDJSON，每行一个完整 JSON 对象：

```json
{ "id": "entry-1", "content": "<p>First frozen entry content</p>" }
```

最小成功响应、`501` 错误和 NDJSON 样本位于 `packages/compat-contracts/contracts/fixtures`。
阶段 1 实现具体接口时，在保持这些公共 envelope 的同时补充逐接口真实 payload fixture。

## 变更流程

```bash
# 日常 CI 和本地检查
pnpm contracts:check

# 仅在有意升级 SDK 或改变客户端 API 使用面时执行
pnpm contracts:update
pnpm contracts:check
```

升级流程必须同时完成：

1. 审阅生成清单 diff，确认 method、path、字段和流式格式变化；
2. 把每个新调用分配到一个 capability；
3. 为本地实现补响应、错误和流式 fixture；
4. 更新固定版本和 schema hash；
5. 依次通过 typecheck、lint、test 和 Web build；
6. 验证通过后才提交生成清单和基线变更。

## 已验证命令

阶段 0 基线已通过：

- `pnpm run typecheck`
- `npm exec turbo run format:check typecheck lint`
- `npm exec turbo run test`
- `pnpm run build:web`

这些结果证明固定代码组合可安装、类型检查、测试和构建。需要登录态的人工阅读链路应在阶段 1
首个自有后端 vertical slice 中，用本地账号和本地 RSS fixture 执行；阶段 0 不保存或采集任何
个人 FOLO 凭据与生产响应。
