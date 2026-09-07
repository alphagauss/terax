# 桌面 UI 样式

Terax 使用紧凑桌面密度，业务页面复用公共控件与语义 token。尺寸和样式定义以 `components/controls/`、`components/layout/`、`components/settings/` 与 `styles/globals.css` 为准，菜单使用 `components/menu/`。

## 展示规则

- 页面只声明布局与不同于默认的规格，不重复覆盖控件字号、圆角、焦点和动画；新通用规格放公共入口。
- 普通设置使用组内分隔行，供应商、Agent、SSH 连接等独立实体保留卡片或列表详情。同字段多选项使用一个容器内的勾选行，不逐项套卡片。
- 父容器拥有间距；页面标题、组标题和字段复用已有布局组件。布局组件不持有配置、提交或校验规则。
- 小字号说明使用语义文字色，不叠加透明度进一步弱化；图表、终端和表格保留自身密度。
- 菜单触发器与设置导航关闭后不留下额外焦点光晕，选中由背景表示；输入焦点使用中性边框，主要操作与错误保留语义色。
- 设置顶部导航空间足够时居中，溢出时起点可达，滚轮横向滚动并保持当前项可见；只在该视口使用原生平滑滚动，reduced motion 直接定位。

## 布局与动画

顶层 SplitView 只使用 react-resizable-panels 和稳定 ID。拖动期间用 DOM ref 与 transform 更新指示器，仅在 onLayoutChanged 确认交互结束后保存尺寸。

动画复用现有 motion 与时长 token，优先 transform、opacity。图表、Markdown、编辑器与终端等昂贵子树不做几何尺寸过渡，不使用 transition-all、Document View Transition、flushSync、全局平滑滚动或逐帧业务 React 状态。

动画可取消，快速切换从当前视觉状态继续，reduced motion 直接到结果。实时数据更新、输入和加载完成不重新触发页面入场。颜色规则见 [主题](themes.md)，必要的运行时证据见 [调试](ui-runtime-debugging.md)。
