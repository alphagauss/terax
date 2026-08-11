# Workbench 辅助窗口架构

本文定义 Terax Workbench 辅助窗口的产品定位、长期边界和后续设计入口。该能力用于将完整的 Workbench 工作页移动或复制到独立原生窗口，以支持多显示器工作流，并作为 Editor、Terminal、Preview、Alpha 等页面可以共同复用的基础设施。

本文描述的是待开发能力，不表示当前代码已经支持通用辅助窗口。具体状态协议、窗口 API、页面迁移和恢复方案应在实施任务开始前结合当时代码进一步设计。

## 产品定位

Workbench 辅助窗口是当前 Workspace 的附属显示窗口，不是新的 Workspace，也不切换运行环境。它在产品体验上接近 VS Code 的浮动工作页：用户可以把一个 Workbench 页面移到另一块屏幕，继续使用原 Workspace 的文件、进程和服务。

```text
Workspace 应用进程
  Rust Workspace 状态与运行时资源
  主 Workbench 窗口
    Space、Group 和普通标签页
  设置窗口
    固定的设置应用入口
  Workbench 辅助窗口
    一个独立显示的 Workbench 页面
  Workbench 辅助窗口
    另一个独立显示的 Workbench 页面
```

辅助窗口具有独立的原生位置、尺寸和焦点，可以放置在不同显示器上。它仍然从属于创建它的 Workspace 应用进程，主窗口关闭时一并关闭，不能脱离原 Workspace 独立存活。

## 首期范围

首期以简单、可复用的单页面窗口为目标：

- 同一个 Workspace 可以按需创建多个辅助窗口。
- 每个辅助窗口只承载一个完整 Workbench 页面。
- 辅助窗口使用最小窗口外壳，不复制主窗口的 Sidebar、Activity Bar、状态栏或完整 Space 导航。
- Workbench 提供“移动到新窗口”“复制到新窗口”和返回主窗口的统一入口。
- 移动操作转移页面所有权；复制操作创建新的页面实例或资源视图，是否支持由页面类型声明。
- 辅助窗口继承当前 Workspace 已确定的 Local、WSL 或 SSH 环境，不能自行切换环境。
- 主窗口关闭时统一关闭辅助窗口，并执行必要的保存和资源清理。

首期不要求辅助窗口内部拥有多个标签、递归分割或完整 Workbench 布局。这些能力只有在真实工作流证明需要后再扩展。

## 与现有窗口的区别

### Workspace 主窗口

Workspace 主窗口拥有完整应用框架、Space、Workbench 布局和 Workspace 生命周期。打开另一个独立 Workspace 主窗口仍按现有模型启动新的 Terax 应用进程。

### 设置窗口

当前设置窗口已经证明同一 Tauri 应用进程可以创建附属 `WebviewWindow`，并使用独立 HTML 入口和 React Root。设置窗口是固定 label、固定路由和固定功能的单例应用，可作为原生窗口创建、主题、标题栏和生命周期处理的参考。

设置窗口不是通用 Workbench 页面宿主。辅助窗口需要动态身份、页面所有权交接、可恢复状态和按页面类型管理运行时资源，不能直接把设置入口扩展成通用容器。

### 新 Workspace 窗口

新 Workspace 窗口拥有独立应用进程、Rust 状态、WebView、PTY、LSP、文件监听、远端连接和 AI 运行时。Workbench 辅助窗口不创建这些资源的第二份所有者，也不获取新的 Workspace 锁或状态文件。

## 页面与运行时边界

Workbench 标签保存可序列化的页面描述，DOM、Canvas、Controller、编辑器实例、终端 renderer 和连接等运行时对象只存在于内存中。

现有 `WorkbenchViewPool` 可以在同一个 WebView 的 Group 之间通过稳定容器移动页面，但不同 Tauri WebView 拥有不同的文档和前端上下文。辅助窗口不能直接接收主窗口中的 React portal、DOM 或 Canvas。后续实现必须为跨 WebView 托管定义明确的交接过程，同时满足以下不变量：

- 页面移动不能意外创建第二份权威业务资源。
- 页面复制不能复用要求独占所有权的运行时实例。
- Terminal 的前端 renderer 与原生 PTY 身份保持分离。
- Editor 未保存内容、冲突状态和文件版本不能在交接时丢失。
- 图表、Preview 和其他昂贵页面只重建必要的显示运行时。
- 交接失败时保留原页面，不能产生无归属标签或静默丢失状态。

页面类型应通过 Workbench 统一能力描述声明是否支持移动、复制和恢复，以及复制时创建新资源还是同一资源的第二个视图。窗口层不得为每种页面建立持续增长的特殊分支。

## 状态、所有权与生命周期

Workbench 必须始终能够确定每个页面当前由主窗口还是某个辅助窗口承载。一个可移动页面在任意时刻只能有一个显示所有者，复制产生的页面使用新的稳定身份。

辅助窗口不重新执行 Workspace 进程级初始化，不运行 PTY 全量清理，也不独立写入可能覆盖主窗口状态的 Workspace Store 快照。跨 WebView 的状态源、命令路由和单写者协议留到实施设计确定，但必须保持当前 Workspace 的环境和资源所有权不变。

窗口关闭至少需要区分：

- 关闭一个辅助窗口。
- 将页面返回主窗口后关闭辅助窗口。
- 关闭 Workspace 主窗口及其全部辅助窗口。
- 页面存在未保存内容、前台进程或其他关闭阻塞项。

具体默认行为、确认交互和重启恢复范围在实施前决定，并由统一 Workbench 关闭协议处理，页面模块不直接管理原生窗口生命周期。

## 性能与安全边界

- 未打开辅助窗口时不得增加额外 WebView、Observer、连接、定时器或 eager bundle 成本。
- 辅助窗口使用按需加载的轻量入口，只加载当前页面需要的模块。
- 动态窗口 label、可调用 command 和 Tauri capability 必须经过显式限制。
- 辅助窗口继承当前 Workspace 授权边界，不能扩大文件系统、Shell、网络或秘密访问范围。
- 多个窗口访问共享资源时必须保持单一权威所有者、引用计数或明确的并发协议。
- 窗口位置和尺寸按稳定辅助窗口身份保存，不与独立 Workspace 主窗口的恢复状态混用。

## 模块职责

- Workbench 负责页面移动、复制、宿主所有权、窗口命令和用户交互。
- Workspace Process 负责当前环境身份和进程级资源，不因辅助窗口发生改变。
- Rust 窗口层负责安全创建、定位、聚焦和关闭附属 WebViewWindow。
- 页面模块提供可序列化描述和必要的重新附着能力，不直接创建原生窗口。
- Settings 保持专用窗口，不承担通用页面托管职责。
- Alpha、Editor、Terminal、Preview 等业务模块不互相依赖辅助窗口实现。

## 分阶段实施建议

1. 先验证同一 Workspace 进程内的通用辅助 WebViewWindow、最小外壳和主窗口生命周期。
2. 以低风险页面验证 Workbench 页面描述、移动、复制、返回和失败回滚。
3. 为 Editor、Terminal、Preview 等具有运行时资源的页面逐类定义重新附着不变量和测试。
4. 最后补充窗口恢复、跨屏拖放、快捷键和更多页面类型支持。

每一阶段都应先阅读 [`ui-runtime-debugging.md`](../contributing/ui-runtime-debugging.md)，在真实 Tauri 运行时验证多窗口焦点、尺寸、拖放、关闭顺序和跨屏行为。

## 实施前需要细化的事项

以下内容有意留到具体任务开始前确定：

- 通用辅助窗口使用独立前端入口还是模式化共享入口。
- 主窗口与辅助 WebView 之间的状态源、事件协议和写入顺序。
- 原生 parent/owner 关系与逻辑生命周期绑定方式。
- 各页面类型的移动、复制和关闭能力矩阵。
- 辅助窗口关闭时默认关闭页面还是返回主窗口。
- 未保存状态、前台终端和长时间任务的确认与转移流程。
- 窗口布局、位置、显示器变化和应用重启后的恢复策略。
- 跨窗口鼠标拖放是否进入首期，或先只提供菜单和命令。

## 相关文档

- [`AGENTS.md`](../../AGENTS.md)：当前项目架构与开发约束的权威入口。
- [双进程模型与 IPC command 参考](two-process-model.md)：Workspace 进程、WebView 与 Rust command 边界。
- [终端 renderer pool](terminal-renderer-pool.md)：终端显示实例与 PTY 资源的生命周期约束。
- [UI 运行时调试](../contributing/ui-runtime-debugging.md)：真实 Tauri WebView 和窗口行为的验证流程。
