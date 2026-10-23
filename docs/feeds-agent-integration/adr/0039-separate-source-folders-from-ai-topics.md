---
status: proposed
---

# 来源与主题分开：侧栏按来源，Chips 按 AI 主题，服务端按主题筛选

## 背景

所有者看条目时用两种分法：

- **按来源**：从哪个源来、可信度如何。分在订阅源上，由所有者手动归到文件夹（Folo 的 subscription
  category），每个源固定属于一个文件夹。
- **按内容**：这一条讲的是什么。分在条目上，同一个源的条目可以分属不同主题。评估时模型已经按 Taxonomy
  给每条写了 `primary_category`、`secondary_category` 和 `tags`（`entry_evaluations`，见 ADR-0035），精选排序按
  `primary_category` 匹配 Taxonomy 顶层分类取半衰期（`processing/featured.ts`）。

界面上两者混在一起，主题这一维还没有用起来：

- 侧栏顶部是 Folo 的内容类型 Tab（文章 / 社交媒体 / 图片 / 视频 …），所有者不用这种分法，但它占着最显眼的位置。
- 条目列表标题下的 Chips（642ac7825）列的是文件夹，和侧栏的文件夹树重复；所有者的文件夹又按主题命名
  （财经商业、新闻与观点），和 Taxonomy 用同一套词，两种分法看起来一样。
- 按 AI 分类筛选只在时间线的 AI 筛选弹层里，是手填的文本框；`applyEntryProjectionFilters` 在客户端对已经加载
  的条目过滤。选一个少见的主题时，第一页可能一条都不剩，列表看起来是空的，要一直翻页才出现内容；未读数和
  "全部已读"也都不知道这个筛选。

## 决策

### 两个维度各占一个位置

- **侧栏 = 来源。** 保留文件夹树，选中文件夹或单个源决定"看哪些源"。内容类型 Tab 只剩一个可见时整行隐藏；
  隐藏哪些沿用现有的 `timelineTabs` 设置，不加新设置项。
- **Chips = AI 主题。** 条目列表标题下的 Chips 改为列当前 Taxonomy 的顶层分类：`全部 · 智能科技 · 财经商业 · …`。
  选中一个顶层分类后，下面出现第二排它的子分类；再点已选中的 Chip 回到上一级。
- **两者取交集。** 侧栏选来源，Chip 选主题，列表显示该来源下该主题的条目。切换来源时保留所选主题，点"全部"
  清除。
- Chips 的顺序按 Taxonomy 里的顺序，不按出现过的值排序，所以顺序固定，子分类跟着父分类。
- 所有者按来源重命名文件夹（通讯社、官方与数据发布、个人博主、Newsletter …），这是所有者的数据，不属于代码改动。

### 主题的含义由 Taxonomy 固定

- 评估提示词明确：`primary_category` 必须是 Taxonomy 的一个顶层分类名，`secondary_category` 是该顶层分类下的
  子分类名，没有合适的子分类时为 `null`。
- 服务端保存前按评估所用的 Taxonomy 快照校验。不在快照里的值照原样保存（评估记录不可变），但主题筛选按
  "其他"处理，不会凭空多出 Chip。
- `processorVersion` 不变。打分语义没有变，改版本号会让全部现有评估显示为配置过期（同 ADR-0038）。旧评估的分类
  按名字匹配当前 Taxonomy；匹配不上的归入"其他"。

### 服务端按主题筛选

- `POST /entries` 增加可选的 `aiCategory`（顶层分类名）和 `aiSubcategory`（子分类名）。查询经
  `entry_current_evaluations` 连到 `entry_evaluations`：
  - 顶层：`primary_category = aiCategory`；
  - 子分类：再加 `secondary_category = aiSubcategory`；
  - `aiCategory` 为保留值 `__other__` 时，取已评估但分类不在当前 Taxonomy 里的条目；
  - `aiCategory` 为保留值 `__unevaluated__` 时，取没有当前评估的条目。
    游标分页、`read`、`feedIdList`、`view` 等条件不变，与主题条件一起作用，所以翻页和"只看未读"都按筛选后的结果算。
- `POST /reads/all` 接受同样两个参数。主题 Chip 选中时，"全部已读"只标这个主题下的条目，不会把整个文件夹标掉。
- `aiSort`（精选排序）可以与主题同时使用：先按主题过滤，再在结果里排序。
- 在 `packages/compat-contracts/contracts/capabilities.json` 增加能力 `entries.ai_topics`。客户端只在服务端宣告
  该能力、且当前 Taxonomy 至少有一个分类时显示主题 Chips；连官方 Folo API 时不显示。
- 为子查询加索引 `entry_evaluations (primary_category, secondary_category)`。条目量在每天约 600 条的量级，先不做
  反范式的分类列。

### 客户端

- Chips 的数据取 `GET /api/extensions/taxonomies` 的当前快照，不再取订阅文件夹。现有 `CategoryChips` 组件改为
  渲染主题，并加第二排子分类。
- 选中的主题放在 `aiEntryFiltersAtom.category`（新增 `subcategory`），作为 `useEntries` 查询键的一部分传给
  `POST /entries`；AI 筛选弹层里的分类文本框删除，由 Chips 取代。分数、标签和"只看失败"仍在弹层里，仍在客户端过滤。
- 选中主题时只用远端结果，不回退本地 SQLite 列表：本地库没有评估数据，按主题过滤不了（同 `aiSort` 的处理）。
- 第一版 Chips 不显示未读数。需要时另加按主题聚合未读数的接口，不在客户端拼。
- 先做桌面端。移动端以后用同样的接口，在时间线顶部做同样的两层 Chips。

## 未采用的方案

- **Chips 继续列文件夹，主题放进筛选弹层：** 来源已经在侧栏，Chips 再列一遍没有增加信息；主题是看列表时最常
  切换的维度，藏在弹层里要多点两下。
- **把 AI 主题做成侧栏里的虚拟文件夹：** 侧栏就同时有两种分法，又回到现在的混淆；而且无法和来源取交集。
- **客户端过滤，自动多拉几页补满：** 冷门主题要拉很多页，未读数和"全部已读"仍然不对；条件应该在查询里。
- **把文件夹自动改成 AI 主题（按源的多数条目归类）：** 一个源的条目常常跨主题（通讯社、X 博主），按源归类正是
  现在主题筛选要解决的问题。
- **Chips 来自实际出现过的分类值：** 顺序随数据变化，模型偶尔写出的非 Taxonomy 值会变成 Chip。

## 影响

- 需要一次迁移，加 `entry_evaluations` 上的组合索引；不加新表。
- 评估提示词多一段对分类字段的约束，前缀仍然字节相同，批量评估的缓存不受影响。
- 改提示词之前的评估里，分类写法不规范的条目会落到"其他"；所有者可以对这些条目发起范围重评。
- 642ac7825 加的文件夹 Chips 由主题 Chips 取代；侧栏内容类型 Tab 在只剩一个时隐藏，对仍在用多个类型的用户不变。
- 未读数暂时只有来源维度（侧栏），主题维度没有，直到加聚合接口。
