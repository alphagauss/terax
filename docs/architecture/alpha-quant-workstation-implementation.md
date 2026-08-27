# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项任务，不重复长期架构和具体实现设计。完成任务时同步更新长期架构中的“当前 Terax 基线”；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：阶段一，公共图表和工作台内核。
- 当前任务：从 OpenTerminalUI 移植并裁剪成熟的 Lightweight Charts 图表内核，结合 shioaji-pro-app 的生命周期实践，替换 Terax 当前临时 K 线组件。已完成。
- 下一任务：建立工作台布局协议、Panel Registry 和稳定面板挂载层。
- 阻塞：无。

## 当前任务

目标是把成熟的参考实现转换为由 Terax 自己拥有的公共图表内核，为数据管理、工作台、回测复盘和模拟交易提供稳定基础。

- 定向检索 OpenTerminalUI 和 shioaji-pro-app 的图表生命周期、历史回填、状态展示和测试，独立选择适合 Terax 的实践。
- 移植并裁剪 OpenTerminalUI 的核心渲染、更新保护和 rAF 批处理，删除其市场、数据源、Store 和高级图表功能依赖。
- 使用 `FinancialChartController` 管理 Lightweight Charts 实例和命令，公共组件不暴露 Alpha API response 或 Lightweight Charts 类型。
- 接入左侧历史分页和 viewport prepend 补偿，保持主题切换、页面隐藏和标的切换时的实例与可见范围不变量。
- 直接替换数据管理页的临时 `AlphaFinancialChart`，不保留兼容包装或冗余实现，并通过纯函数、Controller 和 React 测试锁定关键行为。

完成标准：数据管理页使用新的公共图表内核；历史向左加载不改变用户正在观察的内容；主题、标的和页面可见性变化不会无故重建图表；旧临时组件被删除；后续工作台 Chart Panel 可以直接复用该组件。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

### 目标与范围

- 以 OpenTerminalUI 的 MIT 图表实现为主要代码参考，移植适合 Terax 行情模型的渲染、更新和调度逻辑。
- 以 shioaji-pro-app 的图表行为为补充参考，独立实现请求隔离、历史分页、viewport 保持和标的切换保护。
- 首期覆盖蜡烛图、OHLC Bar、收盘线、成交量 pane、十字线信息、主题、尺寸、历史分页和完整状态展示。
- 不实现实时行情、指标、绘图、多图同步、Footprint、下单或工作台网格。
- Alpha 尚处开发阶段，不保留旧组件兼容层、迁移分支或无调用方的扩展抽象。

### 实施步骤

1. 提取 Terax 行情到 Lightweight Charts series 数据的纯转换与尾部更新判断，并移植相关 rAF 批处理实践。
2. 建立 `FinancialChartController` 和公共 `FinancialChart`，管理单实例生命周期、series、主题、尺寸、十字线和 viewport 命令。
3. 建立数据页行情 scene，使用现有排他游标 API 执行左侧历史单飞加载、跨页合并和旧请求隔离。
4. 用公共图表直接替换 `AlphaFinancialChart`，补齐工具栏、信息栏、状态覆盖层和中英文文案。
5. 删除旧临时组件及其冗余测试，更新长期架构中的当前 Terax 基线。

### 验证标准

- 纯函数测试覆盖时间转换、series 数据、尾部判断和 viewport prepend 补偿。
- Controller 测试覆盖单实例、主题更新、尺寸批处理、历史 prepend 和销毁清理。
- React 测试覆盖数据页按需加载、左侧分页、状态展示和旧请求隔离。
- 运行 `pnpm lint`、`pnpm check-types` 和相关 `pnpm test`。
- 在真实 Tauri WebView 中使用同一组测量复验 Canvas、ResizeObserver、左侧加载和 viewport 保持。

### 执行结果

- 公共图表已经支持蜡烛图、OHLC Bar、收盘线、成交量 pane、十字线信息、主题、rAF 尺寸更新、国际化状态反馈和初次加载重试。
- 数据页已经通过 `MarketChartScene` 使用排他游标加载更早历史，仅在用户操作时间轴后发起请求；跨页合并为线性复杂度，停滞游标会终止分页，旧查询按标的键隔离，历史 prepend 通过逻辑索引补偿保持 viewport。
- 旧 `AlphaFinancialChart` 及其测试已删除，没有保留兼容层；OpenTerminalUI 的 MIT 归属已写入 `THIRD_PARTY_NOTICES.md`。
- `pnpm lint`、`pnpm check-types` 和完整 `pnpm test` 通过，共 210 个测试文件、1,070 项测试。
- 真实 Tauri WebView 使用本机 Alpha 数据完成复验：新标的静置时保持 500 根，首次拖动后加载到 1,000 根，继续拖动后加载到 1,500 根；类型切换、页面隐藏和恢复、历史加载时 Canvas 身份保持不变，十字线离开后恢复最新行情，CDP 未捕获运行时异常。

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
- [ ] 建立工作台布局协议、Panel Registry 和稳定面板挂载层。
- [ ] 完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- [ ] 让数据页、独立行情页和工作台 Chart Panel 复用同一个公共图表。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
