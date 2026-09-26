# 阶段 4.3：上游 SDK 0.3.96 兼容与增量同步

上游 Folo 在 desktop 1.14.0 / SDK 0.3.96 引入了客户端增量同步引擎（上游设计见
`docs/superpowers/specs/2026-09-16-sync-engine-design.md`）。本阶段让自有后端兼容新客户端，并实现
引擎依赖的服务端变更日志。决策依据见
[ADR 0030](./adr/0030-log-user-changes-in-the-write-transaction.md)。

## 兼容修复

- **分页游标是位置性的。** 客户端把上一页最后一条的时间放在 `publishedAfter`（最新优先）或
  `publishedBefore`（最旧优先，`sortOrder: "asc"`）里，期望拿到排在它之后的条目。此前服务端按字面
  时间范围解释，最新优先时间线的第二页恒为空。`POST /entries` 现在把两者都当作游标，数据层的
  `publishedAfter` / `publishedBefore` 仍是字面时间边界（重评接口依赖它）。
- **收藏按加星时间分页。** 收藏时间线以 `collections.createdAt` 为游标，服务端改为按加星时间排序和比较。
  同一毫秒内加星的多个条目在严格比较下可能被跳过，属已知边界。
- **契约扫描覆盖同步模块。** 同步引擎通过 `syncApiContext.provide(followApi.sync)` 间接调用 SDK，
  扫描器现在追踪这种模块传递，`/sync/state`、`/sync/delta` 进入冻结的 API 使用面。

## 反向代理信任

Fastify 5.12 不再接受数字形式的 `trustProxy`：按跳数信任无法校验直接连入的对端，客户端绕过代理即可
伪造 `X-Forwarded-For`。`TRUST_PROXY_HOPS` 因此改为 `TRUST_PROXY` 地址列表，仍设置非 0 跳数时服务
拒绝启动并给出迁移提示，而不是静默地把所有客户端都当作代理地址限流。生产模板使用
`loopback,uniquelocal`。

## 变更日志

`sync_actions` 是按用户追加的变更日志，id 来自全局序列；`sync_floors` 记录每个用户被清理掉的最大 id。
两个数据层实现（PostgreSQL 与内存）通过 `apps/server/src/sync/actions.ts` 的同一组构造函数写日志，
保证动作形状一致。

| model               | action | data                                                                    | 产生于                                          |
| ------------------- | ------ | ----------------------------------------------------------------------- | ----------------------------------------------- |
| `subscription`      | I/U/D  | `GET /subscriptions` 形状（含 `feeds`）/ 变更字段 / 无                  | 订阅、OPML 导入、`PATCH /subscriptions`、分类   |
| `list_subscription` | I/U/D  | 含 `lists`（带 `owner`）的列表订阅 / 变更字段 / 无                      | `POST /lists`、列表视图变化、取消列表订阅       |
| `list`              | U/D    | 变更字段或 `{ feedIds }` / 无；删除时发给所有者和全部订阅者             | `PATCH /lists`、`/lists/feeds`、`DELETE /lists` |
| `collection`        | I/D    | `{ entryId, feedId, view, createdAt }` / 无；重复加星不记录             | `/collections`                                  |
| `timeline`          | U      | `{ entryIds, read, isInbox, feeds }`，仅真正翻转的条目，每行最多 500 个 | `/reads`、`/reads/all`                          |
| `timeline`          | N      | `{ feedId, count, unread, latestPublishedAt, from }`                    | Feed 抓取真正插入新条目时，每个订阅者一行       |
| `action`            | U      | `{ rules }`                                                             | `PUT /actions`                                  |
| `setting`           | U      | `{ payload, updatedAt }`；含凭据的 `ai` 页只记录 `{ updatedAt }`        | `PATCH /settings/:tab`                          |

不记录的模型：`inbox`、`inbox_entry`、`messaging`，自有后端尚未提供这些能力。

## 接口

- `GET /sync/state` 返回用户最新 `lastSyncId`。
- `GET /sync/delta?lastSyncId=N&limit=500` 返回之后的动作、`hasMore` 与 `reset`；`limit` 上限 1000。
  游标低于清理下限（丢失了被删除的行）或高于用户已记录的最大 id（来自另一个数据库，例如实例被重建或
  从备份恢复）时返回 `reset: true`，客户端重新做快照。
- `GET /reads` 在同一个只读 repeatable-read 事务里读取未读数和 `lastSyncId`，客户端据此只应用快照之后
  的计数变化。
- 记录日志的写接口在响应顶层返回 `lastSyncId`（用户当前最新 id），传输队列据此在引擎追上后释放本地覆盖。
- 其余 `/sync/*` 路径保持 404，与新客户端对旧服务端的降级约定一致。

## 保留与清理

每日维护清理删除 30 天前的动作并抬高该用户的下限；`N` 提示 3 天后删除但不抬高下限，客户端每小时的
未读校准会补上漏掉的计数。清理数量计入运维清理报告的 `syncActionsDeleted`。

相对上游的简化：单一 PostgreSQL 权威库，不需要 KV 头缓存和在线状态裁剪；轮询是按 `(user_id, id)`
索引的一次查询。

## 验证

- `apps/server/tests/sync.test.ts` 对内存和 PostgreSQL 两个实现运行同一组场景：全部模型的动作形状、
  不翻转不记录、凭据不入日志、分页、快照配对、过期与异库游标重置、畸形游标。
- 自托管 E2E 在页面加载后由“另一设备”直接调用 API 重命名订阅，触发窗口 focus 后断言界面无刷新地
  更新。禁用 `/sync/delta` 时该断言失败，确认变化确实经由同步引擎到达。

## 后续

- `N` 动作暂不携带新条目 id；客户端仍通过分页接口拉取列表头部。
- 推送通道（上游 Phase 3）未实现，其他设备在下一次拉取（focus、上线、60 秒间隔）时获知变化。
