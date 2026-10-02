---
status: accepted
---

# 用独立令牌授权所有者管理网页列表源

网页列表源（ADR-0031）原先只能用供给端 `ADMIN_TOKEN` 通过 HTTP 管理，应用所有者无法在 Folo 设置页中增删改。
ADR-0026 与 ADR-0028 规定核心只持有只读/执行用的 `FEED_SUPPLIER_TOKEN`，且不得取得 `ADMIN_TOKEN`；浏览器
更不能持有任何供给端令牌。

供给端新增可选的第三个令牌 `MANAGEMENT_TOKEN`，核心以 `FEED_SUPPLIER_MANAGEMENT_TOKEN` 持有同一值。它只能访问
`/v1/manage/web-list-sources` 下与管理 API 完全相同的网页列表接口；不能访问凭据、路由实例、目录、页面变化源、
审计或 Feed 物化接口，内部令牌和 `ADMIN_TOKEN` 也都不能访问 `/v1/manage/`。网页列表源不包含任何秘密，因此把它的
管理权交给核心不会扩大凭据暴露面。每个前缀只接受一个令牌，未配置时 `/v1/manage/` 路由不存在。任何环境下它都
必须与所有其他供给端秘密不同。

核心以实例所有者会话保护 `/api/extensions/sources/web-lists`，把请求转发给供给端，并以严格 schema 校验供给端
响应，只把契约字段返回浏览器；供给端的 4xx 校验与冲突错误原样返回；5xx 等其余错误只在核心日志记录细节，向浏览器统一返回固定的 502 消息。审计事件的操作者记为
`folo-owner <用户 ID>`，不写入邮箱等个人资料。只有配置了管理令牌且网页列表源可用时，核心才宣告
`sources.web_list_management` 能力，桌面端据此显示管理界面。

页面变化源、凭据和目录仍只能通过 `ADMIN_TOKEN` 管理；如需扩展所有者管理范围，应逐类评估其是否包含秘密。
