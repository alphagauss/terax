# 上游跟踪说明

- 上游仓库：https://github.com/crynta/terax-ai.git
- 跟踪的上游分支：`upstream/main`
- 初始基线提交：`78a0b3dd79554ad4af89e61d97004f3475cd9953`

## 同步策略

本项目是独立维护的下游分支。上游变更必须经过审查并选择性移植，不整体合并。

本文件及后续新增的上游审查记录统一使用中文。

## 更新流程

每次审查上游更新时，创建临时分支，并在本文件中添加临时更新章节。审查期间持续维护该章节，保证下游适配工作可以跨多个工作会话延续。

临时章节必须记录：

- 临时分支、跟踪的上游分支，以及已审查的提交或提交范围。
- 每项选中、跳过或暂缓的上游变更及其原因。
- 下游专用适配、修复、未解决问题和后续工作。
- 已完成的验证以及剩余的合并阻塞项。

更新完成并可以合入下游 `main` 后，删除临时详情，仅在同步历史中保留简洁记录。

## 当前审查：2026-08-21

- 临时分支：`chore/upstream-merge-review-2026-08-21`
- 跟踪的上游分支：`upstream/main`
- 审查范围：`fcff6c5b4cff4d00c85e6c2d587672d33f30ea38..f675a713ffc4562cf3f11b3abab4e60384ce9e2e`
- 状态：已拉取并分类 86 个提交；必要修复、依赖与 CI 更新，以及适用于下游现有功能的测试均已完成移植。
- 选入第一批移植：
  - `ed3c7e1`：已移植为 `44579fa`。保留 release 配置中的 `strip = true`，但禁止剥离构建依赖，确保 macOS 的 proc-macro 动态库可以正常加载。
  - `70bfbde`：已移植为 `177ae3d`。避免 Conda 保留 Terax 包装函数时出现 Fish 提示符递归，并加入可执行的 Fish 回归测试和 CI 接入。
  - `4634739` 和 `2b2973f`：已手工移植为 `837bda0`。在 alternate screen 应用中将 readline 按键交给原生应用处理，并保留下游稳定终端身份、智能剪贴板和 TUI 鼠标路由。
  - `7037d55`：已手工移植为 `27b7dd8`。限制活动状态下的 Explorer 搜索区域高度，避免长搜索结果溢出外层侧栏，同时保留下游动画 token 和国际化文本。
  - `5459024`：已手工移植为 `476d9b3`。普通 URL 和 OSC 8 共用原生 opener 与封闭协议白名单，并在成功、失败或拒绝后恢复终端焦点；未改动下游 Markdown 渲染器。
  - `a61bce2`：已手工移植为 `c44badf`。仅在 Space 和 Workbench 恢复完成后消费冷启动的 Open With 文件，并保留下游 Workspace 授权和路径规范化边界。
- 选入第二批非功能性移植：
  - `fd1e78c`、`156fbfb`、`f428f9b`、`6f81665`、`307cb35`、`649727a`、`eab7bb7`、`26a334c`、`4eced10`、`d1daa87` 和 `486639a`：已汇总移植为 `daddf29`。保留下游专用前端依赖，并将上游涉及的包更新到仓库三天供应链观察期允许的同主版本最新稳定版；仅开发期的 `vite-plugin-inspect` 按上游升级至 v12。
  - `5463119`、`b16b663`、`e50a04b` 和 `e048347`：已汇总移植为 `dfa41bf`。依据下游 `Cargo.toml` 重新解析全部兼容版本，避免用上游锁文件删除下游功能依赖。
  - `46b6073`、`65902bf`、`cc628f8` 和 `d1cd31b`：已汇总移植为 `bb529ad`。全部下游工作流统一使用 `actions/setup-node@v7`，CI 中的 `taiki-e/install-action` 固定为 `v2.85.12`，未引入上游 SignPath 策略。
  - `f3abcb3` 中的 Markdown 路径、Explorer 相对路径和终端范围读取测试已移植为 `2ee7153`；Agent 查找测试并入 `e9afbf5`。
  - `d010ba4` 和 `ebed02e` 已手工移植为 `06bc1a9`，按下游跨平台修饰键和快捷键注册表调整断言。
  - `1aa587a`、`3eec888`、`60cd093` 和 `253d761` 已汇总移植为 `e9afbf5`，覆盖 Agent 名称、待办约束、子 Agent 失败收敛和模型偏好去重。
  - `36aff66` 和 `66baaff` 已手工移植为 `c665695`，适配下游 Workbench 命令标识和上下文结构。
  - `74a9a68` 已移植为 `3a2ee53`，锁定 Git 历史图轨道宽度上限。
- 建议后续统一决定：
  - `9f329a2`：已手工移植为 `2d96e73`。本地和 SSH 目录读取统一使用数字感知的自然排序，并通过共享函数保持文件树与面包屑一致。
  - `1fdbc50`：建议在确认需要完整 Svelte 编辑体验后，增加按需加载的 Svelte 语法支持和 Prettier 适用范围。该变更耦合较低，但会新增一个生产依赖，应作为独立功能提交。
  - 注册表已有 AI SDK 与各 provider、Babel、TypeScript、TanStack Table、Marked、size-limit 和 Node 类型等跨主版本更新。建议分别建立迁移批次并验证 API、构建和体积，不在纯依赖同步中直接升级；KaTeX 的 `0.16` 到 `0.18` 同样按可能破坏兼容的升级处理。
  - `pnpm-workspace.yaml` 要求依赖发布至少满三天。`pnpm outdated` 显示但 `wanted` 未接受的同主版本更新继续等待观察期，不绕过 `minimumReleaseAgeStrict`。
- 暂缓，等待针对性验证或产品决策：
  - `bd577d8`：macOS 韩文及中日韩文字 IME 桥接。该修复有价值，但依赖 xterm 私有状态，采用前必须在真实 macOS Tauri 运行时中复现并完成回归验证。
  - `4e2f7f7`、`6af950d`、`93b6b24`、`40ad56b` 和 `a975822`：光标样式、批量关闭标签、换行列数、运行中进程关闭确认偏好和隐藏文件快捷键属于可选 UX 功能，不是回归修复。
  - `e14f7f1`、`5f5b216` 和 `f675a71`：通知声音和通知投递加固。移植前应结合下游通知 store 和已国际化的设置界面重新评估。
  - `c1ec0e6`、`0b5e81b`、`81e718c` 和 `ae7dd20`：编码 Agent 启动器和注意状态系列。该系列此前已经暂缓，目前仍与下游 Agent 和 Workbench 身份模型重叠。
  - `21cbca6`、`aa65cb1`、`1648ba3`、`0ec16d8`、`2dd6361` 和 `b3f053b`：内置 CLI 控制平面。该系列新增经过认证的 IPC 接口，并与 Workspace runtime 和 handoff 职责重叠，应作为独立架构提案处理。
  - `2825090`、`c67f021`、`9fd09f5`、`66f61a6` 和 `fd630a4`：面板重设计、默认主题重写、Xcode 主题和原生窗口背景。这些是成套的上游设计选择，不适合作为安全的同步材料。
  - `5676de7` 和 `d23e16f`：SignPath 发布签名。工作流内包含上游 SignPath 组织和项目标识，缺少下游自有凭据和发布策略时不能复用。
- 跳过，下游已有独立等价实现或更先进的实现：
  - `d630bb3`：eager-graph 的 shebang 已经不存在。
  - `2e86730`：Explorer 拖拽和操作系统文件拖拽已经可以写入终端。
  - `40c4c89`：Workbench 已经支持工作树和提交文件 diff 标签。
  - `fa68ae3`：LSP 状态提示和已国际化的预设已经提供安装指导。
  - `28d7578`：标签关闭控件已经与触发器分离，并阻止指针事件冒泡。
  - `3d53686`：下游仓库控制器已经支持重新发现和选定嵌套仓库。
  - `89c65f0` 和 `cf30c25`：下游已经持久化终端字体家族、大小、字重和间距，并实时更新 renderer。上游的主题级字体覆盖只应作为独立主题功能重新考虑。
  - `33cc6aa`：下游快捷键匹配已经支持 Shift 改写后的物理标点键，并使用自己的国际化快捷键定义。
  - `c1744ff`：下游通过较新的多侧栏布局模型持久化侧栏运行时宽度。
- 不直接 cherry-pick：
  - 版本号、Nix 源和仅与发布图标相关的元数据（`b8dc2bd`、`e9ee1d6`、`2141d16` 和 `f86ba9f`）不代表下游发布状态，继续舍弃。
  - 上游 README、路线图、翻译、截图和工具注释（`04c6091`、`222fc62`、`4d5f454` 和 `a86fd9f`）不描述下游产品。
  - 纯测试提交中，`4a4a167` 与 `fcfbded` 已合并移植为 `6cf54c0`，覆盖 Git 错误格式、upstream 拆分与路径规范化；`75332f6` 已移植为 `649927f`，覆盖 Windows WSL 输出解码。
  - `fd99bf6` 不移植。下游 `fileMutation.test.ts` 已覆盖有序批量修改、唯一替换、全部替换、并发准备共享、审批快照生命周期和条件写入冲突，比上游旧 `edit` 工具测试更贴合当前实现。
- 已完成的验证：
  - 已确认上次审查点是 `upstream/main` 的祖先，并检查了范围内每个提交及其变更文件集合。
  - 已比较补丁等价性和当前下游功能标记。新增提交中没有与下游补丁完全相同的提交，但部分功能已有上文列出的独立等价实现。
  - 已对推荐补丁运行 `git apply --check`。`ed3c7e1` 和 `70bfbde` 可以完整应用，其余选中变更需要手工适配。
  - `44579fa` 已通过 `cargo metadata --locked --no-deps --format-version 1`；`177ae3d` 已通过补丁格式检查，本机未安装 Fish，其可执行回归由新增 Linux CI 步骤覆盖。
  - `837bda0` 已通过终端按键映射的 25 项测试、`pnpm check-types` 和 `pnpm lint`；lint 保留 31 项与本次修改无关的既有警告。
  - `27b7dd8` 已通过 Explorer 的 51 项测试、`pnpm check-types` 和 `pnpm lint`；lint 警告基线未变化。
  - `476d9b3` 已通过外链策略和终端链接的 6 项测试、`pnpm check-types` 和 `pnpm lint`；lint 警告基线未变化。
  - `c44badf` 已通过启动文件与 Space 恢复的 12 项测试、`pnpm check-types` 和 `pnpm lint`；lint 警告基线未变化。
  - `2d96e73` 已通过自然排序 3 项单元测试、文件系统 25 项集成测试、Rust 格式检查和全目标 clippy。
  - `6cf54c0` 已通过 GitError 7 项测试、Git utils 13 项测试、Rust 格式检查和全目标 clippy。
  - `649927f` 已通过 Windows WSL 输出解码 4 项测试、Rust 格式检查和全目标 clippy。
  - `daddf29` 已通过冻结锁文件安装、`pnpm check-types`、`pnpm lint` 和更新前的完整 996 项前端测试；lint 保留 32 项既有警告和 2 项既有提示。
  - `dfa41bf` 已通过 `cargo fmt --all -- --check`、全目标 clippy 和 `cargo test --locked`；库单元测试 483 项、文件系统集成测试 25 项和 Git 集成测试 40 项全部通过。
  - 第二批新增或扩展的 14 个测试文件已通过 64 项针对性测试、`pnpm check-types` 和逐文件 lint。
  - 完整前端验证已通过：198 个测试文件、1049 项测试、`pnpm check-types` 和 `pnpm lint`。lint 保留 32 项既有警告和 2 项既有提示，本批新增文件的逐文件 lint 无诊断。
  - 完整 Rust 验证已通过：`cargo fmt --all -- --check`、`cargo clippy --all-targets --locked -- -D warnings` 和 `cargo test --locked`。本机没有 nextest，已按项目约定回退；库单元测试 483 项、文件系统集成测试 25 项、Git 集成测试 40 项全部通过。
- 剩余合并阻塞项：本机没有 Fish，`177ae3d` 的可执行回归需要由新增 Linux CI 步骤确认。macOS CJK IME 等暂缓项、Svelte 支持和可选 UX 功能不属于本轮必要修复，保留在本章节等待后续统一决策。

## 同步历史

- 2026-07-10：已将选定的上游变更同步到下游 `main`，对应下游提交为 `6bdcd1ed40b633dfabb859957a8fcd8d9f8e5f7c`。
- 2026-07-14：已审查 `upstream/main` 至 `a2c8329662ade6fef8c1e11f7353a7231256937d`，并在 `chore/upstream-merge-review-2026-07-14` 上移植已接受的变更。
- 2026-07-19：已审查 `upstream/main` 至 `fcff6c5`，cherry-pick `fcff6c5`，手工移植 `ac88362`，并移除过期的 Star History 嵌入。暂缓 Agent 标签状态、`5c2f4cd`、Pi 支持、警告折叠和 SignPath 署名。
