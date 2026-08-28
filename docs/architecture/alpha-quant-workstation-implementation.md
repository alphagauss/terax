# Alpha 综合量化工作站实施进度

本文临时记录 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的当前阶段和下一项跨层任务，不重复长期架构和具体实现设计。Rust 与前端细节记录在 `docs/architecture/`，Python 实现基线记录在 [`alpha/docs/`](../../alpha/docs/README.md)。完成任务时同步更新对应长期文档；全部阶段完成后删除本文并移除相关入口。

## 当前状态

- 当前阶段：公共图表批次二，指标与多图分析。
- 当前任务：任务 4，指标领域协议与首批服务端计算。已完成。
- 下一任务：任务 5，指标 pane、legend 与管理界面。任务 4 完成后连续实施。
- 已暂缓：独立 `alpha-market` 行情页，待公共图表能力稳定后重新安排。
- 阻塞：无。

## 当前任务

目标是建立 Alpha 权威、与图表引擎无关的指标 definition 和批量计算协议，首批支持 SMA、EMA、BOLL、RSI 和 MACD，并让前端 Scene 具备按需查询边界。本任务不创建指标 pane 或管理界面。

- Python 复用 `alpha.backtest.indicator.Indicators`，不复制技术指标公式。
- FastAPI 提供 definition 目录和最多 8 个实例的批量计算，参数、字符串、时间范围和结果长度均有界。
- 计算按全部实例的最大 lookback 读取一次含 warmup 的行情，只返回用户请求区间内的升序结果。
- 前端新增 Zod 边界模型、稳定 query key 和 Scene 按需查询；颜色、线宽和 pane 高度不进入计算键。
- 没有可见指标或页面不可见时不发指标请求，查询失败不影响主 K 线状态。

完成标准：首批五类指标可批量返回稳定的 instance/output 结果；NaN 和 Infinity 归一化为 `null`；前端只持有 engine-neutral result；没有 active study 时不产生额外计算和请求。

## 当前任务方案

本节是覆盖式临时记录。每次开始新的 Alpha 任务前，必须先用新任务的目标、范围、实施步骤和验证标准完整替换本节，不保留已完成任务方案的历史副本。长期结论和已完成基线同步到长期架构，任务历史由 Git 保存。

长期边界见 [Alpha 综合量化工作站](./alpha-quant-workstation.md) 的“图表状态和领域模型”，Python 模块边界见 [Alpha Python 后端架构](../../alpha/docs/architecture.md)。本节只记录任务 4 的执行范围和验证结果。

### 目标与范围

- 只实现五类固定指标，不增加用户 JavaScript 指标、公式插件或完整指标目录。
- definition 是服务端权威，instance 只包含稳定 ID、类型和参数，服务端不返回名称、颜色或图表类型。
- 单请求最多 8 个实例，单实例和参数字符串使用明确上限，行情读取沿用存储范围查询和现有 bars 上限。
- Scene 本任务只接入查询与局部错误状态，不提前实现任务 5 的 series、pane、legend、配置持久化或交互。

### 实施步骤

1. 增加纯 definition、参数校验和计算测试，锁定默认值、边界、MACD 交叉约束、缺失值和批量实例身份。
2. 实现 `alpha/chart/studies.py`，集中定义、lookback、现有 `Indicators` 调用和有限 JSON 数值归一化。
3. 增加 studies 目录与批量计算 API，按最大 lookback 读取一次行情并裁剪回请求范围，补齐 route 测试。
4. 增加前端 engine-neutral schema、API 和稳定 query key，在 Scene 中只对可见 active instances 启用请求。
5. 运行 Alpha 相关 pytest、前端类型检查、lint 和测试，审核批量上限、一次读取和未启用零成本边界。

### 验证标准

- 五类 definition 的稳定 type、参数 key、output ID、pane、series kind 和 levels 与计划一致。
- 参数缺失使用 definition 默认值，未知参数、越界值、重复 instance ID 和 `fast >= slow` 在 API 边界拒绝。
- warmup 覆盖最大 lookback，响应只含请求区间且时间升序；输出长度异常时整次计算失败，不返回错位部分结果。
- wire time 与 `/bars` 保持一致，前端复用 `normalizeMarketTime()`，拒绝未知 series kind、重复 instance ID 和非法时间。
- query key 包含数据键、实际起止时间和规范化实例，不包含样式；页面不可见或没有 visible instance 时不请求。
- 指标查询失败只形成 Scene 局部状态，不清空 bars，也不改变主图的 loading、empty 或 error 状态。

### 执行结果

- 既有 TA-Lib `Indicators` 已提升到中立的 `alpha/analytics/indicator.py`，回测旧路径保留兼容导出。回测与图表共用数组公式，图表 definition、参数规则和 output 映射位于 `alpha/chart/studies.py`，API 时间与 JSON 形状没有进入回测。
- Alpha 新增五类稳定 definition 目录和批量计算接口。请求最多 8 个实例、4,000 根显示区间行情，拒绝重复 ID、未知或越界参数、错误步进、`MACD fast >= slow` 和额外原始 `bars` 字段。
- 计算根据最大 lookback 通过一次有界历史读取取得显示区间与 warmup，在工作线程调用公共指标内核，并统一把 NaN 和 Infinity 转为 `null`。依赖异常、非有限输入或输出长度错位会让整批返回结构化错误，不返回部分结果。
- 前端新增引擎无关 Zod 模型、definition 与 calculation API、稳定计算签名和 React Query key。study point 复用 `normalizeMarketTime()`；Scene 只在页面可见、实际起止时间已知且存在 visible 实例时请求，历史 prepend 后按新起点刷新，指标失败不改变主 K 线状态。
- 本机真实 TA-Lib 诊断中，4,500 根输入含 500 根 warmup、4,000 根显示区间和 8 个指标生成 56,000 个点，纯计算与结果组装中位约 0.016 秒。该数字不含数据库 I/O 与 JSON 序列化，只用于确认实现量级。
- Alpha 测试为 234 通过、2 跳过、1 个既有异步测试因环境缺少 `pytest-asyncio` 被取消选择；该测试另用 `asyncio.run()` 执行通过。完整前端测试为 225 个文件、1153 个测试，`pnpm check-types` 与 `pnpm lint` 通过，lint 只保留仓库既有的 25 个 warning 和 2 个 info。
- K4 不创建指标 series、pane、legend 或管理界面，因此按计划没有启动 Tauri UI。真实公式由本机 TA-Lib 性能诊断覆盖，路由数据读取使用隔离数据库替身，没有修改用户行情库。

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
- [x] 加固公共图表的平移边界、视图重置、紧凑高度适配和 TradingView 署名。
- [x] 建立工作台布局协议、Panel Registry 和稳定面板挂载层。
- [x] 完成 24 列网格、Panel Chrome、布局模板和主标的 follow/pinned。
- [x] 让现有数据页和工作台图表面板使用受控周期、复权和图表类型。
- [x] 完成专业价格、时间与 pane 语义。
- [x] 完成图表导出与可访问性。
- [x] 完成指标领域协议与首批服务端计算。
- [ ] 在公共图表能力稳定后重新安排独立行情页。

### 后续阶段

- [ ] 阶段二：数据同步、质量检查、失败恢复和领域 API 边界。
  - [x] 完成 A 股日线同步的最小质量与定向重试闭环。
- [ ] 阶段三：策略、回测和复盘。
- [ ] 阶段四：实时行情和模拟交易。
