# Alpha 集成架构

本文只定义 Terax Rust、React、Alpha Python 服务和可选原生计算模块之间的长期职责边界。Python 服务内部架构、API 与行情存储语义见 [Alpha 后端文档](../../alpha/docs/README.md)；综合量化工作站、公共金融图表、面板布局和实施顺序见 [Alpha 综合量化工作站设计与参考项目指南](./alpha-quant-workstation.md)。

## 架构定位

Alpha 是由 Terax 管理和使用的独立 FastAPI 量化后端。Terax 提供统一的桌面界面、工作区、AI Agent、设置和通知能力，Alpha 提供量化业务 API、任务运行时和数据访问。

```text
Terax React 页面与 AI Agent
              |
              | Tauri command / Channel
              v
Terax Rust Alpha 运行时与通用代理
              |
              | HTTP / WebSocket
              v
FastAPI /api/alpha
              |
              v
Alpha Python 领域模块
              |
              | 可选 PyO3 调用
              v
alpha-native Rust 计算模块
```

多个 Terax 窗口是同一 Alpha 后端的多个客户端。Alpha 业务状态不保存在单个页面或 Rust 代理中。

## 模块职责

| 模块 | 职责 | 边界 |
| --- | --- | --- |
| `alpha/` | 提供 FastAPI 量化业务协议，内部设计由 `alpha/docs/` 记录 | 不维护 Terax 前端、AI Agent、工作区或第二套用户界面 |
| `alpha-native/` | 适合 Rust 实现的量化计算和性能热点，通过 PyO3 供 Alpha 调用 | 不承载 FastAPI、进程生命周期或 Terax UI |
| `src-tauri/build_support/alpha.rs` | 构建时筛选 Alpha 运行源码、生成确定性压缩归档和 Release revision | 不包含 Python 解释器、第三方依赖、数据、测试或开发工具 |
| `src-tauri/src/modules/alpha/` | Alpha 启停、探活、凭据注入及通用 GET、POST、WebSocket 转发 | 不复制 Alpha 领域模型，不解释或重组业务响应 |
| `src/modules/alpha/` | Alpha 页面、图表、交互状态和 API 调用封装 | 不直接管理 Python 进程，不绕过 Rust 访问受管 Alpha 后端 |
| `src/modules/ai/` | Alpha 相关 Agent 工具、审批和对话集成 | 通过与页面相同的 Alpha API 调用链访问业务能力 |

## 打包与运行目录

- Dev 和 Test 构建不压缩 Alpha，也不把 Alpha 文件注册为 Cargo 构建输入。Rust 直接以仓库根目录为工作目录，通过用户配置的解释器执行 `python -E -m alpha`，并按运行文件相对路径和内容计算 `dev:<sha256>` revision。
- Release 构建由 `src-tauri/build_support/alpha.rs` 把必要的 `.py` 文件和 `requirements-runtime.txt` 压缩进 Terax 可执行文件，不使用 Tauri resources，也不使用 PyInstaller。
- Release 首次启动 Alpha 时，Rust 在跨进程文件锁内把归档释放到 `~/.terax/alpha/runtime/<archive-hash>/`。先写临时目录并校验入口和哈希标记，再通过同目录重命名发布，因此其他进程不会看到半成品。
- 内容哈希发生变化时使用新的运行目录。旧目录不在启动路径上自动删除，避免影响仍在运行的旧版本服务。
- Alpha Python 后端配置统一保存在 `~/.terax/alpha/config.json`，默认数据目录为 `~/.terax/alpha/data/`，用户可在 Alpha 设置页把数据目录改到独立的同步位置。该文件只由 Python 后端拥有，不保存 Terax 前端状态。
- Terax 前端的 Alpha 配置统一保存在 `~/.terax/shared/terax-alpha.json`，通过白名单共享 store 加锁并原子更新，供本机多个 Terax 窗口共享。所有窗口都是这份配置的等价读写客户端，不区分主窗口和临时窗口的持久化所有权。工作台布局、主标的和前端偏好不得写入 Python 后端配置、Workspace store 或 `localStorage`。
- Alpha 日志位于 `~/.terax/logs/alpha/`。Python 默认把 `__pycache__` 写入对应的内容哈希运行目录，使缓存跟随源码版本且无需额外缓存状态。
- 发行物仍是一个裸 Terax 可执行文件。源码只有在运行 Alpha 时才以普通文件形式出现在本机运行目录中，Python 无法直接从 Tauri resource 或压缩字节中导入整套包。

## 共享服务生命周期

- 本机所有 Terax 进程共享一个监听 `127.0.0.1:11123` 的 Alpha 服务。每个窗口都是等价客户端，不维护窗口私有的服务状态。
- Python 解释器绝对路径和自动启动开关通过 Terax 共享设置保存。首次未配置解释器时不自动启动，由用户在 Alpha 设置中选择解释器。
- Python 运行环境以 `requirements-runtime.txt` 作为唯一依赖清单，通过 `python -E -m alpha.runtime_check` 逐项真实导入。最低版本为 Python 3.11；保存解释器时只校验绝对文件路径，只有用户主动检查才执行版本和依赖自检，为后续前端依赖管理保留清晰边界。
- 服务启动不重复执行 Python 自检。解释器或环境后来发生变化时，由子进程提前退出和 `~/.terax/logs/alpha/service.log` 暴露真实错误，Rust 不等待完整启动超时。
- 应用 Ready 后延迟协调统一的 `runtime_revision`。服务未运行时只有已配置自动启动才创建服务；服务已经运行但 revision 或协议不一致时，无论自动启动开关如何都替换为当前运行源码。
- Release revision 使用 `release:<archive-sha256>`；Dev revision 使用 `dev:<runtime-files-sha256>`。Rust 启动服务时通过 `TERAX_ALPHA_RUNTIME_REVISION` 注入，受认证健康检查返回同一值，并返回当前服务完成初始化的 UTC `started_at`。
- Debug 构建使用系统原生文件通知递归监听 `alpha/`，只接受生产运行集合中的 Python 文件和 `requirements-runtime.txt`。事件经过防抖后调用同一协调入口；停止状态不会因文件变化而隐式启动。
- 多个开发窗口可能同时收到变更，但所有判断都在 `service.lock` 内重新执行。首个窗口完成替换后，其他窗口发现 revision 已一致并直接返回。
- 启动、停止和重启共用 `~/.terax/alpha/service.lock`。该锁只串行化操作，服务是否运行始终以带凭据的健康检查为准。
- Alpha 凭据保存在 `~/.terax/alpha/service.token`，只由 Rust 注入请求。停止通过受认证的 `/api/alpha/system/shutdown` 完成，不根据陈旧 PID 终止未知进程。
- 若固定端口被无法认证的进程占用，Terax 报告冲突并拒绝启动或停止该进程。
- 探活先确认凭据与 `terax-alpha` 服务身份，再独立判断协议、就绪状态和 revision。已认证的旧协议服务可以安全停止并替换，不会被误判为未知端口占用者。

## 核心原则

### FastAPI 是业务边界

- Alpha 对 Terax 暴露的接口统一位于 `/api/alpha`。
- Rust 和 React 只消费公共 HTTP/WS 协议，不依赖 Python 内部 Repository、任务对象或 provider 模型。
- HTTP 查询结果是前端恢复时的权威状态；WebSocket 只承载 Alpha 已显式定义的公共事件。
- 认证、错误、时间、复权、分页、任务和当前 WebSocket 基线见 [Alpha API 协议](../../alpha/docs/api-contracts.md)。
- Rust 不自动重连 WebSocket。前端按页面生命周期决定是否重连，并在连接恢复后重新查询 HTTP 权威状态。
- 当前前端 `EventClient` 在单个 WebView 内复用一条 `/events` 连接，按 `event + key` 引用计数并负责重连和 selector 重放；`MarketDataFeed` 只是图表领域适配器。Rust 仍只报告 message、error 和 closed，不解释任务、行情或交易事件。

### Rust 代理保持通用

- Rust 负责可信目标限制、连接管理、传输错误、凭据注入和必要的资源边界。
- Rust 使用稳定的通用请求与事件通道，不为每个 Alpha 接口建立一组领域 command 和结构体。
- 通用 HTTP 代理只接受 `/api/alpha` 下的 GET、POST 和 JSON，通用 WebSocket 代理支持双向 JSON 消息。两者都固定访问本机共享服务并由 Rust 注入凭据。HTTP 探活和转发显式禁用自动代理，不受环境变量或内置共享代理选择影响；Python 对外数据源仍独立管理网络。
- `/api/alpha/system/*` 只能由专用生命周期命令访问，不能通过通用代理转发。
- 通用代理不会隐式启动 Alpha。传输失败由 Rust 报告，FastAPI 的 HTTP 业务状态码和 JSON 响应原样返回前端。
- FastAPI 新增普通业务接口时，原则上只修改 Alpha 和前端 API 封装。
- Alpha 服务凭据不暴露给 WebView，FastAPI 仍需独立验证 Rust 注入的凭据。

### 前端保持 Terax 原生体验

- Alpha 页面复用 Terax 的 Workbench、组件、主题、国际化、通知和设置体系。
- Alpha 通过独立活动栏和侧边栏进入。侧边栏只提供模块内导航，具体功能页在当前 Workbench 工作组中打开，不占用全局设置窗口。
- Alpha 可恢复页面只持久化页面类型和稳定资源标识等定位信息。应用重启后重新查询 HTTP 权威状态并按需恢复事件订阅，不持久化查询结果、任务运行状态或连接对象。
- 所有 Alpha 页面共享同一份前端服务状态查询。任意 Alpha 页面可见时探测并轮询服务状态，全部隐藏后停止轮询，重新显示时立即刷新。业务页面只在服务运行时请求 FastAPI 接口。
- Alpha 不提供独立前端壳，不在 FastAPI 中生成展示文案、颜色、图标或交互规则。
- 页面和 AI Agent 共用同一套 Alpha API 封装，避免形成两条行为不同的业务调用链。
- 策略源码仍由 Terax Workspace 浏览和编辑，Alpha 负责发现、加载和执行。

### 原生计算保持可替换

- `alpha-native` 是 Alpha 的可选原生计算层，Python 公开接口应通过集中包装调用 PyO3 扩展。
- PyO3 只承担 Python 与 Rust 的类型转换和调用边界，核心算法优先写成可独立测试的普通 Rust 代码。
- Rust 替换以完整计算边界为单位，并通过 Python 与 Rust 差分测试锁定结果一致性。
- 引入原生实现不改变 FastAPI 协议、React 页面或 AI Agent 调用方式。

## 代码归属

| 变更类型 | 放置位置 |
| --- | --- |
| Alpha 源码筛选、压缩、内嵌归档与 Release revision | `src-tauri/build_support/alpha.rs` |
| Python 业务协议、领域、存储和任务行为 | `alpha/`，设计入口见 `alpha/docs/README.md` |
| 量化计算热点和 PyO3 接口 | `alpha-native/` |
| Python 进程管理、HTTP/WS 转发和凭据注入 | `src-tauri/src/modules/alpha/` |
| 页面、图表、交互和 Alpha API 客户端 | `src/modules/alpha/` |
| Alpha Agent 工具和用户审批 | `src/modules/ai/` 与现有审批基础设施 |

跨越多个边界的功能应先确定权威业务状态属于哪一层，再让其他层保持薄适配，避免复制状态和规则。
