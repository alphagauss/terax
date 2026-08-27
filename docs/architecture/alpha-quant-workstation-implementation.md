# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项任务，不重复长期架构和具体实现设计。完成任务时同步更新长期架构中的“当前 Terax 基线”；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：阶段一，公共图表和工作台内核。
- 当前任务：建立工作台布局协议、Panel Registry 和稳定面板挂载层。已完成。
- 下一任务：完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- 阻塞：无。

## 当前任务

目标是先建立与具体网格和业务面板解耦的工作台内核，让后续面板在拖动、缩放、重排和页面隐藏时保持稳定身份与运行时实例。

- 定向检索 OpenTerminalUI Launchpad 与 shioaji-pro-app Workspace 的面板协议、registry、实例身份和布局校验实践。
- 建立 `AlphaPanelInstance`、`AlphaGridItem` 和 `AlphaWorkstationLayout` 的版本化纯 JSON 协议，分离业务实例与网格几何。
- 建立 descriptor 驱动的 Panel Registry，集中面板元数据、默认配置、配置校验和懒加载入口，不使用中央 JSX `switch`。
- 复用 `WorkbenchViewPool` 的稳定容器与 portal 思路建立 Alpha 面板挂载层，宿主替换、重排和隐藏恢复不得重挂载面板。
- 使用测试 descriptor 和宿主验证基础设施，不提前注册没有真实业务协议的面板，也不创建临时工作台 UI。

完成标准：布局输入能够锁定版本、ID、panel/grid 对应、24 列边界、尺寸、重叠、singleton 和配置不变量；registry 枚举不加载实现且同一类型复用稳定懒加载组件；宿主移动、替换、隐藏和恢复只移动面板 DOM 容器，只有删除面板才卸载实例。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

### 目标与范围

- 以 shioaji-pro-app 的 `blocks + layout` 分离和集中 metadata 为产品结构参考，以 OpenTerminalUI 的懒加载 registry 与测试边界为补充参考。
- 建立 Terax 自有的 `schemaVersion: 1` 布局协议，只保存可序列化面板状态和 24 列逻辑坐标，不保存 React、DOM、Controller、Query 或连接实例。
- 未知面板类型保留为可恢复占位状态；首版拒绝无法识别的 schema 版本，不提前建立没有真实旧版本的迁移流水线。
- 稳定挂载层只拥有面板 React 生命周期和宿主连接，不认识行情查询、工作台持久化或具体网格实现。
- 不实现 24 列拖拽、Panel Chrome、面板库、模板、持久化、标的联动、独立行情页或正式工作台业务面板。

### 实施步骤

1. 定义面板实例、标的绑定、网格项、布局和 JSON 配置模型。
2. 实现布局结构与语义校验，覆盖 panel/grid 一一对应、边界、最小尺寸、重叠、singleton、未知类型和 descriptor 配置校验。
3. 实现 descriptor 注册和查找，创建并缓存每种面板的懒加载组件身份。
4. 实现稳定面板池，通过固定 DOM 容器和 portal 连接网格宿主，提供局部 loading、未知类型和加载失败状态。
5. 使用测试面板验证懒加载、配置传递、宿主移动、宿主替换、隐藏恢复和显式删除的生命周期。

### 验证标准

- 纯函数测试覆盖有效布局和各类结构、几何、singleton 与配置错误。
- Registry 测试覆盖重复类型拒绝、元数据枚举不加载实现和懒加载组件身份稳定。
- React 测试覆盖未知类型、面板级错误隔离和宿主移动、替换、隐藏、恢复、删除时的挂载不变量。
- 运行 `pnpm lint`、`pnpm check-types` 和相关 `pnpm test`。
- 本任务不接入真实网格、Canvas、ResizeObserver 或 Pointer Events，静态检查和 React DOM 生命周期测试足以验证当前边界；真实 Tauri WebView 验证留到下一项 24 列网格任务。

### 执行结果

- 已新增 `src/modules/alpha/workstation/`，布局协议固定分离 panel 状态和 24 列 grid 几何，配置只接受纯 JSON；未知 schema 版本直接拒绝，未建立空迁移框架。
- 布局解析已覆盖 ID 唯一、panel/grid 一一对应、边界、descriptor 最小尺寸、重叠、singleton、标的绑定和配置校验；未知 panel type 保留给挂载层显示占位状态。
- Panel Registry 在注册时缓存每种类型的 `React.lazy` 组件身份，读取面板 metadata 不执行 loader；descriptor 标识符存在首尾空白时直接拒绝，避免与布局归一化后的类型不一致；没有提前注册虚构业务面板。
- `AlphaPanelPool` 和 `AlphaPanelHost` 通过固定 DOM 容器、portal 和 ref 注册保持实例，宿主替换、暂时消失、排序、隐藏和恢复均不重挂载；显式删除清理容器，单个 loader 失败不会影响其他面板。宿主会向后续网格转发 DOM ref、样式、类名和指针事件。
- 新增 3 个测试文件、16 项测试；`pnpm lint`、`pnpm check-types` 和完整 `pnpm test` 通过，完整测试为 213 个测试文件、1,086 项测试。lint 保留 25 个既有 warning 和 2 个既有 info，本次文件没有诊断。

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
- [ ] 完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- [ ] 让数据页、独立行情页和工作台 Chart Panel 复用同一个公共图表。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
