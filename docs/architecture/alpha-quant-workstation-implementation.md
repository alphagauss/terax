# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项任务，不重复长期架构和具体实现设计。完成任务时同步更新长期架构中的“当前 Terax 基线”；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：阶段一，公共图表和工作台内核。
- 当前任务：完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。已完成。
- 下一任务：完成独立行情页，并统一数据页、独立页和工作台 Chart Panel 的 scene 接入。
- 阻塞：无。

## 当前任务

目标是把已经完成的布局协议、Panel Registry 和稳定挂载层接入首个可操作的 Alpha 工作台，在固定 24 列坐标中完成面板拖动、缩放、模板实例化和主标的跟随，并把前端状态跨窗口持久化到 Terax Alpha 共享配置。

- 定向复核 OpenTerminalUI Launchpad 与 shioaji-pro-app Workspace 的网格、Panel Chrome、模板、布局锁定、主标的和持久化实践。
- 建立 Alpha 工作台页面和固定 24 列网格，禁止重叠并采用纵向紧凑排列；窄窗口保留逻辑坐标并横向滚动。
- Panel Chrome 统一承载标题、拖动手柄、follow/pinned 和删除，网格统一提供缩放手柄；业务面板不认识网格坐标。
- 内置模板只作为不可变的初始布局定义，实例化时生成新的面板和布局 ID，不建立用户模板管理功能。
- 工作台布局、主标的和锁定状态统一保存在 `~/.terax/shared/terax-alpha.json`；所有窗口共享读取和写入，不区分窗口级持久化所有权。
- 网格宿主继续使用 `AlphaPanelPool` 的稳定容器，移动、缩放、自动重排和隐藏恢复不得重挂载图表或面板实例。

完成标准：用户能够从 Alpha 入口打开工作台、应用内置模板、拖动和缩放面板、锁定布局、切换主标的并在 follow/pinned 间切换；只在交互结束后提交最终坐标；所有窗口都从共享 Alpha 配置恢复并写入有效状态；真实 Tauri WebView 中 Canvas 身份在拖动、缩放和隐藏恢复后保持稳定。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

### 目标与范围

- 以 shioaji-pro-app 的 24 列 Workspace、Panel Chrome 和主标的交互为产品参考，以 OpenTerminalUI 的模板、持久化测试和边界场景为补充参考。
- 复用现有 `AlphaWorkstationLayout`、Panel Registry 和 `AlphaPanelPool`，不建立第二套布局协议、面板生命周期或中央 JSX `switch`。
- 新增版本化工作台持久状态，原子保存主标的、布局锁定和布局；无效或未知版本回退到默认模板，不持久化 Controller、查询、DOM 或 Canvas。
- 使用固定 24 列 `react-grid-layout`，拖动和缩放过程中只更新网格视觉状态，只在 stop 事件提交最终坐标并合并持久化写入。
- 首批只注册能验证真实工作台链路的现有图表能力，不创建虚构行情、订单、持仓或风险面板。
- 不实现用户模板管理、多联动组、时间范围同步、十字线同步、浮动面板或服务端模板协议。

### 实施步骤

1. 定义并校验工作台持久状态、默认主标的和内置模板，确保模板实例化不修改源定义且生成不冲突 ID。
2. 为 `terax-alpha.json` 建立 Alpha 专用前端持久化入口，完成初始加载、跨窗口读写和刷新、防抖及关闭前 flush。
3. 建立 Alpha 工作台页面、工具栏、固定 24 列网格和 Panel Chrome，接入锁定、删除、follow/pinned、拖动与缩放结束提交。
4. 注册并接入首个真实 Chart Panel，通过 `AlphaPanelHost` 与 `AlphaPanelPool` 保持图表实例稳定。
5. 把工作台加入 Alpha 导航和 Workbench 可恢复页面，所有窗口都使用同一份共享状态，不建立窗口级持久化所有者。

### 验证标准

- 纯函数测试覆盖模板实例化、24 列坐标归一化、主标的解析、follow、pin、恢复跟随和无效持久状态回退。
- 持久化测试覆盖共享 store 读取、任意窗口写入、连续提交合并、失败重试和关闭前 flush。
- React 测试覆盖 Panel Chrome、布局锁定、删除、模板切换以及拖动和缩放只在结束时提交。
- 运行 `pnpm lint`、`pnpm check-types` 和相关 `pnpm test`；公共基础设施或接入范围扩大时运行完整前端测试。
- 按 `docs/contributing/ui-runtime-debugging.md` 在真实 Tauri WebView 中复验拖动、缩放、碰撞重排、窄窗口横向滚动、页面隐藏恢复和 Canvas 实例稳定性。

### 执行结果

- 已新增可恢复的 Alpha 综合工作台页面和侧边栏入口，固定使用 24 列、纵向紧凑排列、碰撞重排和 1,200 px 最小逻辑宽度，窄窗口通过横向滚动保留坐标。
- `AlphaPanelGrid` 不订阅 `onLayoutChange`，只在 `onDragStop` 和 `onResizeStop` 提交全部最终坐标；布局锁定同时关闭拖动和缩放，Alpha 范围内覆盖了依赖默认几何 transition 的第三方样式。
- Panel Chrome 已接入标题、拖动、删除和 follow/pinned。主标的使用统一 `代码.交易所` 校验和大写归一化；固定时复制当前主标的，恢复跟随后立即使用最新主标的。
- 内置单图和双图模板只包含真实 Chart Panel，每次实例化生成新的 layout 和 panel ID；Chart Panel 直接复用现有 `MarketChartScene`，没有新增虚构面板或第二套图表实现。
- 版本化 `AlphaWorkstationState` 作为 `terax-alpha.json` 的单个 `workstation` 键保存。所有窗口的写入都经过 200 ms 合并、白名单共享 store 原子替换和应用关闭前 flush；失败状态保留供重试，不增加窗口身份或并发合并逻辑。
- 新增 5 个测试文件并增加 15 项测试；完整 `pnpm test` 为 218 个测试文件、1,101 项测试。`pnpm lint`、`pnpm check-types`、`pnpm build` 和 eager graph 检查通过，lint 仅保留 25 个既有 warning 和 2 个既有 info。既有 Alpha 远端可见性设置也已从通用 settings store 移入 Alpha 共享 store，不保留旧位置兼容读取。
- 真实 Tauri WebView 已验证单图与双图模板、碰撞重排、缩放、锁定、横向滚动、共享文件恢复和 follow/pinned。拖动、缩放和标签隐藏恢复前后的 Canvas、固定容器与面板 DOM 身份一致，稳定运行期间没有 console error；调试进程已按记录的 PID 停止。

## 外部参考规则

- 两个本地参考仓库同时供 Codex 和开发者检索，不局限于本文已列出的文件或既有建议。
- 新增 Alpha 功能、架构或重要交互前，优先查找两个项目的相关实现、测试和边界行为，再结合 Terax 约束决定采用、组合、简化或拒绝。
- 参考仓库不是 Terax 的构建或运行时依赖。Terax 从第一版就拥有自己的协议、组件 API、状态和持久化边界。
- `shioaji-pro-app` 只吸收产品思想、公开行为和架构经验，不复制或改写其 AGPL 源码。

## 阶段进度

### 已完成基础

- [x] 建立 Alpha 共享服务、通用代理、数据目录、统一行情模型和有界历史读取基础。

### 阶段一：公共图表和工作台内核

- [x] 移植并裁剪公共金融图表内核，替换临时 K 线组件。
- [x] 建立工作台布局协议、Panel Registry 和稳定面板挂载层。
- [x] 完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- [ ] 让数据页、独立行情页和工作台 Chart Panel 复用同一个公共图表。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
