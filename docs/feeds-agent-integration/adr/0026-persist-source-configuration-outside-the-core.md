---
status: accepted
---

# 在核心之外持久化来源配置和凭据

阶段 5A.2 为 `feed-supplier` 配置独立 PostgreSQL、数据库账号、网络和数据卷。Folo 核心数据库不保存来源
凭据、路由绑定或供给审计，核心容器也没有到供给数据库的网络路径。

业务凭据使用 AES-256-GCM 和随机 IV 加密，记录 active key ID；环境 keyring 支持读取历史 key 和事务式
重加密。路由实例只保存稳定 `rsshub://` 地址与秘密查询参数到凭据 ID 的引用，读取 API 永不返回明文。
RSSHub 基础 `ACCESS_KEY` 仍作为部署基础设施密钥管理，不写入业务凭据表。

内部 Feed 协议与管理协议使用不同 Bearer Token。所有管理变更和连接测试写入追加式审计表；数据库触发器
拒绝修改或删除审计事件，独立 HMAC-SHA256 前向哈希链用于检测数据库层篡改。数据库备份只有与外部保管的
keyring 和 HMAC key 配套才可恢复完整能力。
