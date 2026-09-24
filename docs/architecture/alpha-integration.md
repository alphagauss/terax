# Alpha 集成

Alpha 是本机共享的 FastAPI 量化服务。Python 拥有领域与权威数据，Rust 管理生命周期、凭据和通用代理，React 与 Agent 复用同一 API 调用链。Python 内部规则见 [后端文档](../../alpha/docs/README.md)。

## 服务与打包

- 所有 Terax 窗口是同一服务的等价客户端，不创建窗口私有后端。服务固定监听本机回环地址，首次未配置 Python 解释器时不自动启动。
- 解释器与自动启动偏好属于 Terax 共享设置。依赖仅由用户显式安装；保存解释器只验证路径，主动检查才执行版本与依赖自检，启动不重复自检。
- Dev 使用工作树源码，Release 内嵌必要运行源码并在跨进程锁内按内容哈希释放到 `~/.terax/alpha/runtime/`。不打包 Python 解释器、第三方依赖或数据，旧目录不在启动时自动删除。
- 启停、重启与 revision 协调共用 service.lock；存活以带凭据的健康检查为准，不依靠 PID 文件终止进程。
- 已运行且认证成功的旧 revision 或协议服务替换为当前源码；未运行时仅按自动启动开关启动。开发源码变化不隐式启动已停止服务。
- 固定端口被无法认证的进程占用时报告冲突，不停止未知进程。服务令牌保存在 `~/.terax/alpha/service.token`，只由 Rust 注入，不暴露给 WebView。

## 代理与状态

普通业务代理只接受 `/api/alpha` 下的 GET、POST JSON 与双向 JSON WebSocket；system 生命周期路径仅由专用命令访问。代理固定直连，不隐式启动服务，不解释或重组领域响应。HTTP 业务错误与传输失败保持可区分。

Rust 不自动重连业务 WebSocket。前端按订阅生命周期复用连接并恢复 selector，恢复后查询 HTTP 权威状态；事件不能替代快照。

| 状态 | 所有者 |
| --- | --- |
| Python 数据目录等后端配置 | `~/.terax/alpha/config.json`，由 Python 管理 |
| 可同步业务数据 | 用户选择的 data_dir |
| 两套实验布局、各自主标的和前端偏好 | Terax 白名单共享存储 `terax-alpha.json` |
| 页面定位 | Workbench 可恢复页面描述 |
| 查询结果、连接、Controller | 当前运行实例，不持久化 |

所有窗口可读写同一前端配置，不能整表覆盖或写入 Workspace store、Python 配置及 localStorage。页面恢复仅保存稳定资源标识，重新查询数据并建立订阅。Alpha 页面共享服务状态查询，全部隐藏时停止可见性轮询。

## UI 与计算

Alpha 通过活动栏图标直接打开或聚焦 Workbench 中的 Alpha 页面，不提供专属侧边栏。入口与布局行为见 [Alpha 工作站](alpha-quant-workstation.md)，设置从页内打开。界面复用 Terax 控件、主题、国际化和通知。策略源码由 Workspace 浏览编辑，Alpha 发现、加载与执行。

可选 alpha-native 只替换完整计算边界，不能改变 Python 公开行为或 FastAPI 协议；使用差分测试验证结果。Rust 代理不承载 Python 领域模型。图表与工作台规则见 [Alpha 工作站](alpha-quant-workstation.md)。
