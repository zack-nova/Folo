# 阶段四：本地获取与运行稳定化

阶段四把自有 RSS、阅读和 AI 处理闭环提升为可长期运行的后端。所有权威数据继续只保存在本地
PostgreSQL；标准 RSS/Atom 获取、处理、精选和同步都不依赖 Folo 官方服务。

## 获取契约

- 标准源使用 ETag 和 Last-Modified 条件请求；HTTP 304 记为成功，但不重新解析或覆盖 Entry。
- 每个 Feed 独立保存 `consecutive_failures`、最后成功/错误时间和 `next_fetch_at`。
- 失败从 1 分钟开始指数退避，默认上限 24 小时；成功后恢复正常轮询周期。
- 一个轮询周期只刷新到期 Feed；共享订阅仍只抓取一次。周期日志包含刷新、失败、延后数量和受限错误摘要。
- 每个 Feed 最多保存最近 500 条诊断，定期删除 30 天前记录。诊断只保存状态、耗时、HTTP 状态、
  响应 URL、Entry 数和错误摘要，永不保存响应正文。

登录用户可查询自己的订阅：

- `GET /api/extensions/subscriptions/:feedId/acquisition`
- `GET /api/extensions/subscriptions/:feedId/acquisition/diagnostics?limit=20`（最大 100）

`feed_supplier` 只预留为未来外部 RSS 发布器的 provider 名称和适配边界。阶段四不实现其内部抓取、账号、
反爬或发布能力，也不让它成为本地权威存储。

## 数据升级与保留

服务启动顺序是版本预检、Better Auth migration、Drizzle migration、写入当前 schema 版本。当前数据库
schema 版本为 `4`；程序发现数据库版本更高时会拒绝启动，防止旧程序写坏新结构。

每日维护策略：

- Processing Attempt 的大体积执行元数据保留 7 天；成功 Attempt 保留 30 天，失败 Attempt 保留 90 天。
- Feed 获取诊断保留 30 天且每源最多 500 条。
- Entry Evaluation 至少保留最新 10 个版本，且 180 天内不清理；当前指针引用永不清理。
- `succeeded`、`failed`、`superseded` Processing Job 在 180 天后清理；`queued`、`running` 永不清理。

维护结果会写结构化日志，并显示在 `/api/extensions/operations/status`。

## 健康、指标与告警

- `GET /health`：进程存活检查。
- `GET /ready`：数据库可用性检查；失败返回 503。
- `GET /metrics`：Prometheus 文本指标，包含订阅 Feed、退避 Feed、到期 Feed及各状态 Processing Job。
- `GET /api/extensions/operations/status`：仅登录所有者可见，返回最近轮询、最近清理、聚合统计和告警。

默认告警建议：

- `folo_feed_acquisition_failures > 0` 持续 30 分钟：warning；持续 6 小时：critical。
- `folo_processing_jobs{status="failed"}` 在 15 分钟窗口持续增长：warning。
- `/ready` 连续 3 次失败：critical，并停止流量切入。
- PostgreSQL 磁盘使用率超过 80%、最近一次已验证备份超过 24 小时：critical。

日志不得记录 AI Key、Cookie、Authorization、Feed 响应正文或数据库连接串。

## 备份与恢复

```bash
pnpm server:backup backups/folo-$(date +%F).dump
pnpm server:restore:drill backups/folo-2026-08-18.dump
```

备份命令生成 PostgreSQL custom archive 和同名 `.sha256`，拒绝覆盖，并先用 `pg_restore --list`
校验。恢复演练先校验 checksum，再恢复到唯一临时数据库，对比全部权威表行数，最后删除临时库。
`UPLOADS_DIRECTORY` 不在数据库内，必须用独立卷快照一并备份。

正式恢复不要覆盖在线主库：恢复到新数据库，运行 migration 和 `/ready` 检查，再切换 `DATABASE_URL`。

## 生产部署与回滚

1. 复制 `apps/server/.env.production.example` 为 `apps/server/.env.production`，生成独立强随机
   `BETTER_AUTH_SECRET`、`AI_ENCRYPTION_SECRET`、`METRICS_TOKEN` 和 URL-safe `POSTGRES_PASSWORD`。
2. 先执行备份与恢复演练。
3. 运行
   `docker compose --env-file apps/server/.env.production -f apps/server/compose.production.yaml up -d --build`；
   `--env-file` 同时为 Compose 插值和容器加载 `POSTGRES_PASSWORD`。
4. 检查 `/ready`、`/metrics`、能力 manifest 和一条真实 Feed 的手动刷新。
5. 保留部署镜像 digest、迁移前 backup、上传卷快照和配置版本。

生产模式会拒绝 HTTP 公网 URL、复用的认证/AI 加密密钥、缺少指标令牌以及“公开注册 + 私网 Feed”组合。
Compose 默认只绑定 `127.0.0.1:3000`，应由一跳可信反向代理终止 TLS；API 容器使用只读根文件系统、
移除 capabilities、禁止提权并限制进程数。只有临时、明确接受风险的部署才能设置
`ALLOW_INSECURE_HTTP=true`。

生产 Compose 的备份与演练要显式选择生产编排文件：

```bash
FOLO_COMPOSE_FILE=apps/server/compose.production.yaml POSTGRES_PASSWORD=... \
  pnpm server:backup backups/folo-$(date +%F).dump
FOLO_COMPOSE_FILE=apps/server/compose.production.yaml POSTGRES_PASSWORD=... \
  pnpm server:restore:drill backups/folo-2026-08-18.dump
```

回滚时先停止写流量。若新版本未产生数据迁移，可切回上一镜像；若已经写入新 schema，不要让旧镜像直接
连接已迁移数据库，因为引入版本护栏之前的镜像无法识别 `instance_metadata`。应恢复迁移前数据库到新实例
并切换连接，不能依赖或跳过版本检查。回滚后再次验证订阅、时间线、已读、收藏、评估、精选和处理重试。

## 验证与容量基线

```bash
pnpm --filter @follow/server test
pnpm --filter @follow/server bench
pnpm server:test:postgres
pnpm server:e2e:web
pnpm contracts:check
```

服务端投影接口单次固定最多 100 个 Entry，内部使用批量查询；前端对超过 100 个 ID 分页请求。基准覆盖
10,000 Entry 时间线取一页和 100 Entry 批量投影。基准结果用于同一部署环境的回归比较，不作为跨机器
绝对延迟承诺。
