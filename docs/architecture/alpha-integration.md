# Alpha 集成架构

本文定义 Alpha 量化后端、Alpha 原生计算模块和 Terax 各层之间的长期职责边界。具体文件索引见 [`alpha/docs/code-map.md`](../../alpha/docs/code-map.md)。

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
| `alpha/` | FastAPI 接口、领域模型、行情、存储、策略、回测、同步、任务和事件 | 不维护 Terax 前端、AI Agent、工作区或第二套用户界面 |
| `alpha-native/` | 适合 Rust 实现的量化计算和性能热点，通过 PyO3 供 Alpha 调用 | 不承载 FastAPI、进程生命周期或 Terax UI |
| `src-tauri/src/modules/alpha/` | Alpha 启停、探活、凭据注入及通用 GET、POST、WebSocket 转发 | 不复制 Alpha 领域模型，不解释或重组业务响应 |
| `src/modules/alpha/` | Alpha 页面、图表、交互状态和 API 调用封装 | 不直接管理 Python 进程，不绕过 Rust 访问受管 Alpha 后端 |
| `src/modules/ai/` | Alpha 相关 Agent 工具、审批和对话集成 | 通过与页面相同的 Alpha API 调用链访问业务能力 |

## 核心原则

### FastAPI 是业务边界

- Alpha 对 Terax 暴露的接口统一位于 `/api/alpha`。
- FastAPI 负责参数校验、业务错误、任务状态、数据访问和权限判断。
- 重型回测、同步和优化不得阻塞 API 事件循环，应由 Alpha 任务运行时执行。
- HTTP 查询结果是权威状态，WebSocket 用于进度、日志和状态变化通知。连接恢复后由客户端重新查询权威状态。

### Rust 代理保持通用

- Rust 负责可信目标限制、连接管理、传输错误、凭据注入和必要的资源边界。
- Rust 使用稳定的通用请求与事件通道，不为每个 Alpha 接口建立一组领域 command 和结构体。
- FastAPI 新增普通业务接口时，原则上只修改 Alpha 和前端 API 封装。
- Alpha 服务凭据不暴露给 WebView，FastAPI 仍需独立验证 Rust 注入的凭据。

### 前端保持 Terax 原生体验

- Alpha 页面复用 Terax 的 Workbench、组件、主题、国际化、通知和设置体系。
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
| 行情、策略、回测、同步、存储和任务行为 | `alpha/` 对应领域模块 |
| HTTP 路由、请求模型、业务校验和事件协议 | `alpha/api/` |
| 量化计算热点和 PyO3 接口 | `alpha-native/` |
| Python 进程管理、HTTP/WS 转发和凭据注入 | `src-tauri/src/modules/alpha/` |
| 页面、图表、交互和 Alpha API 客户端 | `src/modules/alpha/` |
| Alpha Agent 工具和用户审批 | `src/modules/ai/` 与现有审批基础设施 |

跨越多个边界的功能应先确定权威业务状态属于哪一层，再让其他层保持薄适配，避免复制状态和规则。
