# Source Control 侧边栏 View Container 重构

## 目标

- 将 Source Control 从单体页面重构为统一的 View Container，由通用 `SidebarSectionGroup` 管理多个可折叠、可调整高度的 Section。
- 首批 Section 为 `Changes` 与 `Graph`，两者拥有统一标题栏、折叠交互、动画、按钮区域和 Workspace 级布局持久化。
- `Changes` 保留现有提交输入、暂存、丢弃、分支切换、Fetch、Pull、Push 和刷新功能，不改变 Git 行为。
- `Graph` 使用现有 Git 历史拓扑、分页、commit 详情和 per-file diff 能力，呈现适合窄侧边栏的紧凑视图。
- 迁移上游 PR #924 的 Undo last commit 能力，并修复其 SHA-256 与错误分类问题。
- 保留完整 Git History 编辑器 tab，作为宽屏搜索和详情视图；不保留旧的 Source Control 侧边栏页面。

## 产品结构

```text
Primary Sidebar
├─ SidebarRail
└─ Active View Container
   ├─ Explorer
   └─ SourceControlViewContainer
      └─ SidebarSectionGroup
         ├─ Changes Section
         └─ Graph Section
```

`SidebarSectionGroup` 和 `SidebarSection` 属于 `src/modules/sidebar/`，只负责布局与通用交互。Git 数据、命令和页面内容继续归属 `source-control` 与 `git-history` 模块。

## 明确取舍

- 最终只保留一套 Source Control 侧边栏布局，不长期并存旧 `SourceControlPanel` 和新 Section UI。
- 实施分阶段进行，每一步保持可验证，但最终删除旧页面外壳和独立的 `Commit Graph` 导航行。
- 不实现 View 跨 Primary Sidebar、Secondary Sidebar 和 Panel 的拖放。
- 不实现用户自定义 Section 顺序或隐藏 Section；当前只持久化高度与折叠状态。
- 不把完整 `GitHistoryPane` 直接塞入窄侧边栏；Graph Section 使用紧凑行布局并复用其纯拓扑逻辑。
- 完整 Git History 编辑器继续存在，Graph 标题栏提供 `Open Full Graph` 动作。
- Section 标题栏支持 title、badge、description、actions 和 overflow slot，但不建立命令注册系统。
- 折叠动画只用于点击标题栏触发的展开收起；拖动 separator 时即时响应，不添加尺寸动画。
- Section 布局存入 Workspace 状态，不使用全局 `localStorage`。
- Undo 显示开关属于全局 Preferences，默认开启，并放在独立的 Source Control 设置分组。

## 复现与验收契约

```text
Given: 真实 Tauri Workspace，打开一个有提交历史和工作区改动的 Git 仓库，Source Control 为活动侧边栏视图
When: 展开或折叠 Changes/Graph、拖动分隔线、刷新或创建提交、点击 commit 与文件、重启 Workspace
Expected: 两个 Section 使用一致标题栏；高度与折叠状态恢复；Graph 拓扑、分页和详情正确；文件打开当前 split diff；折叠 Section 不进行无效分页；所有 Changes 操作保持原行为
Actual: 当前 Source Control 是单体页面，Commit Graph 是跳转行，侧边栏没有可复用 Section 容器
Stable: 当前结构稳定复现；新交互需要在真实 Tauri WebView 中验证
```

## 实施步骤

### 1. 通用 Sidebar Section 基础设施

- 新增 `SidebarSectionGroup`，基于现有 `react-resizable-panels` 纵向管理任意数量的 Section。
- 新增 `SidebarSection` 标题栏与 body shell，统一 chevron、标题、badge、description、actions、tooltip、focus 和边框样式。
- 点击标题栏时执行短动画；separator 拖动保持即时。
- 将每个 Section 的像素高度和折叠状态保存到 Workspace store。
- 暴露 `expanded` 与 `toggle`，让业务内容暂停加载或改变空状态。
- 提取纯布局恢复和校验函数，测试无效值、未知 Section、最小高度和折叠恢复。

验证：组件类型检查通过，布局纯函数测试通过，separator 保持键盘可访问。

### 2. Source Control View Container

- 用 `SourceControlViewContainer` 替代旧 `SourceControlPanel` 页面外壳。
- 将当前 commit composer、changed files、仓库状态和 Git actions 迁入 `ChangesSection`。
- 把当前固定 header 的分支和远程操作迁入 Changes 标题栏及其 action slots。
- 删除独立 `Commit Graph` 导航行。
- loading、no repository 和 error 由 View Container 或 Changes Section 提供一致空状态。
- 保留 `useSourceControlPanel` 的业务逻辑，只有在迁移产生明确命名不匹配时才重命名，不重写已验证的 Git mutation 流程。

验证：暂存、取消暂存、丢弃、提交、生成 commit message、Push、Fetch、Pull、分支切换和文件 diff 接线不变。

### 3. 紧凑 Graph Section

- 新增 `GraphSection`，使用现有 `gitLog`、`gitCommitFiles` 和 `GraphRail`。
- 复用 `git-history/lib/graph.ts` 的拓扑计算，不复制图算法。
- 使用虚拟列表呈现 commit graph、subject、相对时间和 refs；在窄宽度下隐藏不必要列。
- commit 详情使用适合侧边栏的 popover；文件点击继续走 `openCommitFileDiffTab`，复用当前 split diff。
- 支持分页、自动填充、加载失败重试和 stale request 防护。
- Graph 标题栏提供 Refresh 与 Open Full Graph。
- 展开状态变化时控制首次加载与后续分页，折叠时不发起新的页面请求。

验证：仓库切换不会混入旧请求；滚动分页不重复 commit；commit 详情和文件 diff 正确。

### 4. Git HEAD 刷新契约

- 解析 `git status --porcelain=v2` 已有的 `branch.oid`。
- 给 Rust 和前端 `GitStatusSnapshot` 增加 `headSha`。
- Graph 以 repo root 与 `headSha` 作为刷新依据，不通过额外 `git log` 轮询检测新提交。
- 增加 parser 和 snapshot 测试，覆盖 detached HEAD、无提交仓库和普通分支。

验证：无 upstream 且工作树干净时，外部 commit 或本应用 commit 后 Graph 仍能准确刷新。

### 5. Undo last commit

- 新增 `git_undo_commit(repo_root, expected_head_sha, workspace)` IPC。
- 使用 `git update-ref HEAD <parent> <expected>` 原子 compare-and-swap，避免并发 commit 误撤销。
- 只接受完整的 40 位或 64 位十六进制对象 ID。
- 仅在 HEAD 确实变化时返回 stale 提示；其他失败保留 `ensure_success` 的 Git stderr。
- 拒绝初始提交；成功后变更保持 staged。
- Undo 只显示在最新且存在父提交的 commit 行，并使用确认对话框；可能已推送时显示明确警告。

验证：成功、stale HEAD、初始提交、64 位校验和真实 update-ref 错误分类测试通过。

### 6. Settings 与接线清理

- 新增 `sourceControlShowUndoCommit` preference、默认值、读写与变更订阅。
- 在 General Settings 新增 `Source Control` 分组，不把 Undo 放进 Explorer 分组。
- 更新 `App.tsx` 接线，传入 commit file diff、完整 Graph 打开动作和 Undo preference。
- 删除迁移产生的旧 props、imports、组件和 storage key，不清理无关代码。

验证：关闭设置后 Undo 行动作消失，重新开启后恢复。

### 7. 运行时验收与质量检查

- 按 `docs/contributing/ui-runtime-debugging.md` 启动真实 Tauri WebView，并记录本次进程 ID。
- 验证初始布局、点击折叠、拖动 separator、窗口缩放、Workspace 重启后的状态恢复。
- 验证 Changes 与 Graph 的 scroll container 没有互相抢占高度或产生双滚动条。
- 验证 Graph 标题栏在窄侧边栏下按钮进入预期布局，键盘 focus 可见。
- 验证创建 commit、Undo、切换分支和仓库后 Graph 更新。
- 验证 commit file 使用当前 `GitDiffStack` 与 split diff。
- 停止本次调试进程并移除临时日志。

## 验收标准

- Source Control 侧边栏只使用 `SidebarSectionGroup`，不存在旧页面与新 Section 两套 header 或布局。
- Changes 与 Graph 都有一致的标题栏、chevron、actions、边框、折叠动画和键盘行为。
- Section 可以承载完全不同的业务内容，不依赖 Git 类型。
- 用户调整的高度与折叠状态按 Workspace 恢复。
- Changes 全部原有操作可用且 diff 行为不变。
- Graph 展示真实拓扑线，支持分页、详情和 per-file split diff。
- Graph 不依赖 changed file 数量推测 HEAD 是否变化。
- Undo 不会撤销竞态期间产生的其他 commit，且不丢失 index/worktree 内容。
- 完整 Git History 编辑器仍可从 Graph 标题栏打开。

## 验证命令

```text
pnpm lint
pnpm format:check
pnpm check-types
pnpm test
pnpm build
pnpm analyze:eager
git diff --check
cd src-tauri && cargo clippy --all-targets --locked -- -D warnings
cd src-tauri && cargo nextest run --locked
```

## 审查后修复与精简计划

### 范围与约束

- 保持现有 Git 操作语义、Section 交互、视觉样式和页面入口不变。
- 局部重构只限于异步请求代际、提交详情缓存和 Section 状态同步，不拆分 `Changes` 大组件，也不引入新的通用状态层。
- 只清理已有证据表明无效或重复的代码；保留暂时未使用但属于通用组件契约的能力。

### 1. Git History 与 Graph 异步一致性

- 区分首次加载与分页加载的失败状态，让对应的 Retry 重试正确操作。
- 为分页请求和提交详情请求增加代际校验，避免刷新、切换仓库或快速切换提交后旧响应覆盖新状态。
- 仓库切换时立即清除旧仓库的提交、详情和撤销确认状态；普通刷新失败时保留当前可用数据。
- 限制 Graph 提交详情缓存大小，并在滚动或再次点击同一提交时关闭详情浮层。

验证：补充或调整相关单元测试，并通过类型检查与前端测试。

### 2. 提交文件详情边界条件

- 让根提交和合并提交也能返回文件状态与增删行数。
- 将 numstat 与文件状态的匹配从重复线性查找改为一次索引，不改变返回结构。
- 增加根提交与合并提交的 Rust 集成测试。

验证：目标 Git 集成测试通过，Rust clippy 通过。

### 3. SidebarSectionGroup 正确性

- 折叠内容使用 `inert` 阻止键盘焦点进入不可见区域。
- 以面板实际折叠状态回写 React 状态，避免布局库拒绝操作时标题与内容状态不一致。
- 为不同 SectionGroup 使用唯一的 View Transition 名称，并协调并发动画清理，避免名称冲突和根节点 class 被提前移除。

验证：Section 布局测试、类型检查通过，并检查动画 CSS 与现有 150ms linear 行为一致。

### 4. 低风险精简与性能优化

- 稳定 Source Control 刷新回调，避免提交消息输入导致 Graph 无意义重渲染。
- 移除无效 memo、一次性 memo 和明显未使用的新增导出；不抽取大型共享组件或改变公共交互。
- 仅对本次涉及文件做格式整理，避免扩大 diff。

验证：lint、format check、类型检查、前端测试、依赖分析和 `git diff --check` 通过；记录仓库既有门禁问题。
