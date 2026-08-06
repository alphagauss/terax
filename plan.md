# Git 实时 Diff 与仓库状态重构计划

## 目标

以单一 HEAD 基线重构编辑器 Quick Diff、仓库状态刷新和 Git diff 标签页，使未保存内容能够实时显示行变更，保存及 Git 操作能够统一刷新 Source Control、Explorer 和打开的 diff 页面。

本次允许破坏内部 TypeScript API 和 Tauri command，不保留旧 command、旧 working diff cache、旧 unified patch parser、旧乐观状态或兼容转发层。用户数据、持久化设置、工作区授权和 Git 路径安全边界保持不变。

## 成功标准

- 编辑受 Git 跟踪的文件后，无需保存即可更新 added、modified、deleted gutter 和 overview。
- 输入期间不启动 Git 进程、不执行文件读取或 IPC。
- 文件顶部插入或删除内容后，既有标记仍映射到正确行。
- 保存、stage、unstage、discard、commit 和仓库文件事件通过同一失效入口刷新受影响消费者。
- 打开的 working diff 页面不会使用旧缓存，也不会被过期异步请求覆盖。
- 同一文件和 HEAD revision 的基线请求合并并使用有界缓存。
- 大文件或复杂 diff 有明确计算上限，不阻塞编辑器输入。
- 删除旧链路后，搜索不到 `git_diff_head`、`gitDiffHead`、`diffCache`、`parseUnifiedDiff`、`applyStatus` 和旧乐观 reconcile 逻辑。

## 设计

### Repository Model

- `useSourceControl` 是当前仓库 `repo`、`status`、loading、error、busy action 和 generation 的唯一状态来源。
- 新增统一的仓库变更通知入口，合并编辑器写入、文件监听和 Git mutation 产生的刷新请求。
- 本地变更按短时间窗口防抖并合并 inflight refresh；窗口 focus 只作为漏事件兜底。
- Source Control 面板直接派生展示状态，不复制 `repo`、`status` 或 `panelState`。
- stage、unstage、discard 和 commit 执行完成后直接刷新真实状态，不维护乐观快照或 reconcile timer。

### Quick Diff Model

- 新增精简 Tauri command，根据文件路径完成授权后的仓库解析，并返回 repo root、相对路径、HEAD revision 和 `HEAD:path` 文本基线。
- 前端按 workspace 与文件路径合并 inflight 请求并维护小型 LRU；缓存项携带 repo、relative path 和 revision，HEAD 变化时按仓库精确失效。
- CodeMirror StateField 保存基线和 `@codemirror/merge` chunks；文档 transaction 使用 `Chunk.updateB` 增量更新。
- gutter、overview rail 和 Git diff 页面统一从 chunks 派生行类型，不再解析 unified patch。
- 对超出编辑器 Quick Diff 限制的文件或超时计算返回空装饰，不能显示错误行号。

### Git Diff 页面

- 删除全局 `diffCache.ts` 和所有手工 invalidation API。
- commit diff 在已挂载页面内加载一次；working diff 根据 repository generation 在可见时重新读取。
- 原生 `git_diff_content` 只为二进制或超大文本生成 fallback patch，普通文本依赖 CodeMirror diff。
- 过期请求通过页面内 generation/request token 丢弃，不写入任何全局缓存。

## 删除范围

- 删除 Rust `git_diff_head` command、`operations::diff_head` 和只为它存在的 HEAD diff mode。
- 删除前端 `native.gitDiffHead`。
- 删除 EditorPane 中 repo resolve、保存后 Git 刷新、request ref 和路径字符串归属判断。
- 删除 `parseUnifiedDiff`、`gitChangesForDiff` 和基于三个行号 Set 的旧 GitChanges 状态。
- 删除 `src/modules/editor/lib/diffCache.ts` 及所有引用。
- 删除 `SourceControlSummary.applyStatus`、乐观 stage/unstage/discard、affected-path invalidation 和 reconcile timer。
- 删除 Source Control 面板复制的 repo、status、panelState 状态。

## 执行与验证

1. 重构 Quick Diff 纯函数和 CodeMirror StateField。
   - 验证：单元测试覆盖新增、修改、删除、顶部插入、连续 transaction、基线替换和计算上限。
2. 新增精简 Git baseline command，并删除 `git_diff_head`。
   - 验证：Rust 测试覆盖普通文件、未跟踪文件、无 HEAD 仓库、路径越界和内容大小限制。
3. 接入 EditorPane，删除保存后 Git patch 链路。
   - 验证：前端测试证明编辑 transaction 不调用 native Git，基线只在 revision 变化时重新加载。
4. 收敛 Repository Model 和 Source Control 面板状态。
   - 验证：测试覆盖事件防抖、inflight 合并、mutation 后刷新和陈旧请求丢弃。
5. 删除 working diff cache，并让页面跟随 repository generation。
   - 验证：测试覆盖页面可见刷新、隐藏期间标脏和旧请求不能覆盖新结果。
6. 删除所有旧符号和兼容代码，检查变更范围及代码文档。
   - 验证：使用 `rg` 确认旧符号归零，并检查所有修改的 Rust、TypeScript 和 TSX 文件具有合格中文文件级注释。
7. 运行最小且充分的完整验证。
   - 前端：`pnpm lint`、`pnpm check-types`、相关 `pnpm test`，最后运行完整 `pnpm test`。
   - Rust：`cargo clippy --all-targets --locked -- -D warnings` 和相关测试；可用时运行 `cargo nextest run --locked`，否则运行 `cargo test --locked`。

## 非目标

- 本次不实现 index 与 HEAD 双 Quick Diff provider。
- 本次不新增 gutter 点击后的 hunk stage/revert 菜单。
- 本次不引入新的运行时依赖或后台 Git polling daemon。
- 本次不修改 Git 会话、持久化设置格式或工作区授权模型。
