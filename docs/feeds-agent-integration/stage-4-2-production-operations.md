# 阶段 4.2：生产验证、安全基线与运维管理前端

阶段 4.2 在不接入真实数据灰度的前提下，完成可重复的生产部署验证、安全边界和所有者运维界面。
真实 RSS/AI 流量灰度明确延期，不作为本阶段完成条件。

## 生产安全基线

- `NODE_ENV=production` 时强制公网 `SERVER_URL`、`CLIENT_ORIGINS` 使用 HTTPS；仅显式设置
  `ALLOW_INSECURE_HTTP=true` 才能临时绕过。
- 认证密钥、AI 加密密钥和 Metrics Bearer Token 必须分别配置，拒绝明显占位值和复用密钥。
- 公共注册不能与私网 Feed 访问同时开启，避免不可信账号借 RSS 获取能力访问内网。
- 全局 API 和认证写请求按客户端 IP 限流；反向代理只按有限跳数信任转发头。
- 写请求拒绝非白名单 Origin 和 `Sec-Fetch-Site: cross-site`；响应启用安全头，日志脱敏认证信息。
- 请求正文、路由参数、头像和 OPML 均有大小上限；Metrics 使用恒定时间令牌比较并返回 Bearer challenge。
- 生产 Compose 默认只绑定回环地址。API 以非 root、只读根文件系统、无 Linux capabilities、禁止提权、
  限制 PID 和滚动日志运行；上传目录和 PostgreSQL 使用独立持久卷。

生产环境模板为 `apps/server/.env.production.example`，编排入口为
`apps/server/compose.production.yaml`。公网流量必须先经过可信反向代理完成 TLS，再转发到回环监听端口。
启动时使用
`docker compose --env-file apps/server/.env.production -f apps/server/compose.production.yaml up -d --build`，
确保 `POSTGRES_PASSWORD` 参与 Compose 插值；仅配置 service `env_file` 不会完成 `${...}` 插值。

## 运维管理前端

设置中的“运维”页面只在能力清单包含 `operations.stability` 时显示，并继续由后端强制要求实例所有者。

页面提供：

- 15 秒自动刷新和人工刷新；健康/降级总状态。
- 订阅 Feed、到期 Feed、退避 Feed、排队/执行中的 AI Job 统计。
- Feed 连续失败、错误摘要、最近失败和下次尝试时间；按需展开最近获取诊断并人工重试。
- 最多 50 个失败 AI Job、失败原因和人工重试。
- 最近一次 Feed 轮询及保留策略清理摘要。
- 加载、空数据、403/网络失败和操作失败反馈；支持窄屏布局且不产生页面级横向滚动。

运维状态仍是只读聚合视图；重试动作只推进已有 Feed 或失败 Job，不允许在此页修改密钥、Feed URL、
用户或数据库结构。

## 已完成的隔离生产验证

使用独立 Compose project、独立 PostgreSQL volume 和临时生产配置完成：

1. 从零构建生产镜像并以只读、非 root 容器启动。
2. 在空数据库执行 Better Auth 与 Drizzle migration，验证 `/health`、`/ready` 和阶段四能力清单。
3. 验证未认证 `/metrics` 返回 401，Bearer Token 可读取 Prometheus 指标。
4. 验证 HSTS、`X-Content-Type-Options`、`X-Frame-Options` 和 Referrer Policy。
5. 检查容器为 `USER node`、只读根文件系统、`cap_drop: ALL`、`no-new-privileges` 和 PID 256 上限。
6. 创建 PostgreSQL custom backup 与 SHA-256，恢复到隔离数据库并对比 26 个公共表后删除演练库。
7. 删除验证 Compose project、容器、网络、volume 和临时环境文件；未触碰开发数据库。

验证中发现并修复两项生产启动问题：Docker 工作目录归属导致的非 root 写入失败，以及 Better Auth 在
空数据库查询最早用户时只选择 `id` 却按 `createdAt` 排序造成的 SQL 错误。最终隔离栈达到 healthy。

最终镜像使用两阶段构建、服务端专用冻结锁、isolated linker 和 BuildKit pnpm store。生产清单在构建阶段
移除 workspace 的 `devDependencies`，并关闭 optional peer 自动安装，避免 Better Auth 和 Drizzle 从共享锁
继承 Next、Vitest、Expo SQLite、React Native 等前端/移动端依赖。最终运行层直接执行 `tsx`，不包含 pnpm、
Corepack 或 package store。

本次本机 arm64 产物 digest 为
`sha256:e33c7f8c32eaae8f3bf3429a6e1c4475f1999abcf016463d54c167cc6c11d164`，Docker inspect 体积为
96,380,166 bytes；相较优化前 755,018,715 bytes 减少 87.2%。pnpm 的 Linux 安装记录从 1,965 个包降至
149 个包，减少 92.4%。镜像仍只复制 server、Drizzle migration、兼容契约和 readability 源码。

修改 server 或上述 workspace package 的运行依赖后，必须重新生成并提交专用锁；Docker 的 frozen install
会在清单与锁不同步时直接失败：

```bash
pnpm --filter @follow/server prod:lock:update
docker build -f apps/server/Dockerfile -t folo-server:local .
```

## 发布门禁

```bash
pnpm --filter @follow/server test
pnpm --filter @follow/server prod:lock:check
pnpm server:test:postgres
pnpm server:e2e:web
pnpm contracts:check
pnpm typecheck
pnpm lint:fix
pnpm test
```

真实数据灰度恢复时，应另建发布任务，使用专用 Feed/AI 额度、分级告警和可撤销流量切换；灰度结果不回写
本阶段的契约或完成状态。
