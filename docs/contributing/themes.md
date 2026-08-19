# 主题开发指南

Terax 的应用主题负责 UI 表面、文字、交互、Git、图表、侧边栏、滚动条和终端配色。编辑器语法高亮是独立体系，由应用主题的 `editorTheme` 选择对应的 CodeMirror 主题。

## 权威来源

- `src/modules/theme/types.ts`：主题数据类型和完整变体约束。
- `src/modules/theme/themeRegistry.ts`：主题字段到 CSS 变量的唯一注册表。
- `src/modules/theme/themes/modern.ts`：完整的 Light Modern 和 Dark Modern 基准。
- `src/modules/theme/applyTheme.ts`：模式选择、Modern 补全和 CSS 变量写入。
- `src/styles/globals.css`：React 挂载前的 Modern 安全回退。
- `src/styles/workspace-bootstrap.css`：主窗口和辅助窗口的冷启动背景。

新增主题字段时必须先登记类型和注册表，不得在校验器、终端读取器或业务组件中另建字段清单。

## 解析与兼容规则

1. Light Modern 和 Dark Modern 是对应模式的完整基准。
2. 当前主题只覆盖自己显式声明的 UI 和终端字段。
3. 未声明字段由当前模式的 Modern 补全。
4. 只有一个变体的主题在另一模式下继续使用其已有变体，但缺失字段仍由请求模式的 Modern 补全。
5. 自定义主题允许局部配置，以兼容已有 `.terax-theme` 文件。
6. 未登记字段会被校验器拒绝，避免拼写错误静默失效。

`CompleteThemeVariant` 用于 Modern 等基准主题，确保新增字段时编译器立即报告遗漏。新建内置主题也应优先使用完整变体，现有局部主题可在后续主题整理中逐步补齐。

## UI 字段

当前每个完整变体包含 48 个 UI 字段。

### 基础表面与文字

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `background` | `--background` | 工作区和页面基础背景 |
| `foreground` | `--foreground` | 默认正文和主要图标 |
| `card` | `--card` | 卡片、标签栏等次级表面 |
| `cardForeground` | `--card-foreground` | 卡片主要文字 |
| `popover` | `--popover` | 菜单、弹层和浮窗表面 |
| `popoverForeground` | `--popover-foreground` | 弹层主要文字 |
| `primary` | `--primary` | 品牌操作、焦点和主要选择 |
| `primaryForeground` | `--primary-foreground` | Primary 表面上的文字 |
| `secondary` | `--secondary` | 次级控件表面 |
| `secondaryForeground` | `--secondary-foreground` | Secondary 表面上的文字 |
| `muted` | `--muted` | 弱化表面和占位区域 |
| `mutedForeground` | `--muted-foreground` | 次级说明和辅助信息 |
| `accent` | `--accent` | 菜单、控件等强调表面 |
| `accentForeground` | `--accent-foreground` | Accent 表面上的文字 |
| `destructive` | `--destructive` | 删除、失败和危险操作 |
| `success` | `--success` | 成功、已连接和新增状态 |
| `warning` | `--warning` | 警告、等待和已修改状态 |
| `info` | `--info` | 信息、重命名和普通提示状态 |
| `border` | `--border` | 常规边框和分隔线 |
| `input` | `--input` | 输入控件边界和表面 |
| `ring` | `--ring` | 键盘焦点和强调描边 |

### 交互状态

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `interactiveHover` | `--interactive-hover` | 列表行和轻量控件悬停 |
| `interactiveActive` | `--interactive-active` | 当前项、活动项和键盘候选项 |

Hover、active、selected、focus、右键目标和拖放目标是不同状态。`interactiveHover` 与 `interactiveActive` 不能替代 Primary 选择、focus ring 或拖放描边。

### Git 与编辑器变更标记

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `gitModified` | `--git-modified` | 文件树已修改文件名 |
| `gitAdded` | `--git-added` | 文件树新增文件名 |
| `gitUntracked` | `--git-untracked` | 文件树未跟踪文件名 |
| `gitRenamed` | `--git-renamed` | 文件树重命名文件名 |
| `gitDeleted` | `--git-deleted` | 文件树删除状态 |
| `editorGitModified` | `--editor-git-modified` | 编辑器修改 gutter |
| `editorGitAdded` | `--editor-git-added` | 编辑器新增 gutter |
| `editorGitDeleted` | `--editor-git-deleted` | 编辑器删除 gutter |

### 图表

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `chart1` | `--chart-1` | 第一组分类或序列 |
| `chart2` | `--chart-2` | 第二组分类或序列 |
| `chart3` | `--chart-3` | 第三组分类或序列 |
| `chart4` | `--chart-4` | 第四组分类或序列 |
| `chart5` | `--chart-5` | 第五组分类或序列 |

### 侧边栏

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `sidebar` | `--sidebar` | 主副侧边栏背景 |
| `sidebarForeground` | `--sidebar-foreground` | 侧边栏主要文字 |
| `sidebarPrimary` | `--sidebar-primary` | 侧边栏主要选择和焦点 |
| `sidebarPrimaryForeground` | `--sidebar-primary-foreground` | Sidebar Primary 上的文字 |
| `sidebarAccent` | `--sidebar-accent` | 侧边栏强调表面 |
| `sidebarAccentForeground` | `--sidebar-accent-foreground` | Sidebar Accent 上的文字 |
| `sidebarBorder` | `--sidebar-border` | 侧边栏边界 |
| `sidebarRing` | `--sidebar-ring` | 侧边栏焦点描边 |

### 滚动条与圆角

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `scrollbarThumb` | `--scrollbar-thumb` | 滚动条滑块 |
| `scrollbarThumbHover` | `--scrollbar-thumb-hover` | 滚动条悬停滑块 |
| `scrollbarTrack` | `--scrollbar-track` | 滚动条轨道 |
| `radius` | `--radius` | 应用基础圆角倍率 |

## 终端字段

| 字段 | CSS 变量 | 用途 |
| --- | --- | --- |
| `background` | `--terminal-background` | 终端背景 |
| `foreground` | `--terminal-foreground` | 终端默认文字 |
| `cursor` | `--terminal-cursor` | 光标颜色 |
| `cursorAccent` | `--terminal-cursor-accent` | Block 光标内文字 |
| `selection` | `--terminal-selection` | 终端选区 |

`ansi` 必须包含 16 个颜色，顺序固定为：black、red、green、yellow、blue、magenta、cyan、white，然后是对应的 8 个 bright 颜色。

## 透明度规则

透明度只应用于确实需要叠加到底层表面的效果，不用于反复弱化有意义的文字。

建议保留透明度的场景：

- 遮罩、阴影、毛玻璃和浮层。
- 终端或编辑器选区。
- 边框、ring 和装饰性分隔线。
- 禁用、拖拽和渐隐动画。
- 从语义状态色生成的浅色背景。
- `interactiveHover` 这类需要适配多个底层表面的交互覆盖层。

应避免的场景：

- `text-muted-foreground/60` 之类对次级文字再次降级。
- 使用 `hover:bg-accent/30` 表示本应清晰的列表 hover。
- 在业务组件中用透明度临时补偿不合适的主题 token。
- 同一个状态同时叠加文字透明度、父级 opacity 和半透明背景。

有意义的小字号文字优先直接使用 `foreground` 或 `mutedForeground`。确实需要第三层文字时，应新增明确语义，而不是继续降低透明度。

## 新建自定义主题

设置页的新建主题操作会创建同时包含 `light` 和 `dark` 的完整 Modern 模板，然后在 Terax 代码编辑器中打开 `.terax-theme` 文件。两个变体都包含全部 UI、终端和 ANSI 字段。

只需要单模式时可以删除另一变体。保留双模式时，应分别调整两套颜色，不能仅复制数值并依赖 `.dark` Tailwind 覆盖。

## 新增内置主题

1. 复制 `src/modules/theme/themes/modern.ts` 的字段结构。
2. 为 light 和 dark 分别配置颜色；确实只有单模式时可以只提供一个变体。
3. 使用 `CompleteThemeVariant`，避免遗漏新增字段。
4. 指定合适的 `editorTheme`，不要把语法高亮颜色复制到应用主题中。
5. 在 `themes/index.ts` 注册主题，并同步设置中的主题模式和名称元数据。
6. 检查普通文字、次级小字号文字、hover、active、focus、Git 状态和终端 ANSI。
7. 增加测试锁定字段完整性和主题关键身份色。

## 验证

主题基础设施或内置主题变更至少运行：

```bash
pnpm lint
pnpm check-types
pnpm test
pnpm build
```

局部纯配色修改可以先运行相关主题测试，但提交前仍需根据影响范围补足验证。运行时截图不是确定性颜色修改的默认步骤；如果问题依赖真实 WebView 合成、背景图片、透明窗口或动态测量，则遵循 `docs/contributing/ui-runtime-debugging.md`。
