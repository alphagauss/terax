# 安全说明

Terax 可以运行命令、读写文件并把上下文发送给模型。内置 Agent 的“请求批准”和“完全访问”模式、文件版本保护及进程隔离见 [安全模型](docs/architecture/security-model.md)。请求批准模式也允许 cwd 内非敏感的普通操作自动执行。

外部 CLI Agent 使用 CLI 自身的权限机制，详见 [外部 Agent](docs/architecture/external-agent-runtime.md)。终端和 Agent 以当前系统用户权限运行，模型服务会接收明确发送的内容。

模型凭据使用系统密钥链或 Linux secrets 文件，不进入普通设置与会话正文。内置 HTTP 的目标检查及代理信任边界见 [网络规则](docs/architecture/network.md)。

本下游仓库不沿用上游的联系渠道、签名发行或安全响应时限承诺。报告可能泄露凭据或可直接利用的问题前，应先与当前维护者确认私下披露渠道，不在公开问题中提交秘密。
