# Folo Feed Supplier

阶段 5A 的独立数据源供给服务。当前切片把 `rsshub://` 逻辑地址转换为自建 RSSHub 的标准 RSS/Atom，
并通过内部 Bearer Token 只向 Folo 主后端开放。

本地通常直接运行仓库根目录的 `pnpm dev:self-hosted:sources`。单独开发时：

```bash
cp apps/feed-supplier/.env.example apps/feed-supplier/.env
pnpm --filter @follow/feed-supplier dev
```

生产必须设置彼此不同的 `INTERNAL_TOKEN` 与 `RSSHUB_ACCESS_KEY`。服务不会保存站点凭据，也不会向主后端
返回 RSSHub access key。阶段 5A 完整契约见
[`stage-5a-autonomous-sources.md`](../../docs/feeds-agent-integration/stage-5a-autonomous-sources.md)。
