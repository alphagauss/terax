# AI 文件工具统一后端重构计划

## 目标

将模型可见的文件工具从 `read_file`、`list_directory`、`glob`、`grep`、`write_file`、`create_directory`、`edit`、`multi_edit` 直接替换为职责清晰的六个工具：

- `read_file`：读取已知 UTF-8 文本文件。
- `find_files`：目录列举和递归路径匹配。
- `grep`：文本内容搜索。
- `write_file`：创建或完整重写单个文本文件，并自动创建父目录。
- `apply_patch`：对一个或多个已读取文本文件执行严格的精确替换。
- `file_operation`：移动、复制、删除路径或显式创建空目录。

项目仍处于开发阶段，不保留旧工具名、旧参数、历史 JSONL 渲染或 IPC 兼容层。前端只定义模型 schema、审批要求和薄调用；路径解析、安全策略、读取状态、搜索结果过滤、修改准备、版本校验和 Local、WSL、SSH 路由统一由 Rust Agent 文件后端负责。

## 核心不变量

- 六个工具分别对应读取、路径发现、正文搜索、全文写入、局部编辑和文件树操作，不以工具数量为目标制造万能 schema。
- 所有相对路径基于聊天首次发送时冻结的 cwd；Agent 文件后端只允许访问该工作区根目录内的路径。
- Local、WSL、SSH 使用相同请求、响应、分页、错误、安全、审批和并发语义。
- 只读工具自动执行；`write_file`、`apply_patch` 和 `file_operation` 动态遵守当前审批模式。
- 敏感路径、符号链接越界、控制字符、特殊设备和非普通文本文件在 Rust IPC 边界拒绝；搜索结果使用同一规则过滤。
- `read_file` 使用 1-based 行号、明确的下一页位置和基于路径、范围、内容版本的去重；UTF-8 截断不破坏字符边界。
- `write_file` 通过 `mode=create|rewrite` 明确区分新建和完整重写，父目录自动创建；重写已有文件必须先读。
- `apply_patch` 只修改已有 UTF-8 文本文件，所有目标必须先读；全部替换先在内存中规划，非 `replace_all` 匹配必须唯一。
- `write_file` 与 `apply_patch` 的审批预览和提交共享同一 Rust prepared mutation；提交前重新验证 canonical path 和文件版本，拒绝覆盖审批后变化的文件。
- 多文件修改先完成全部校验再写入，每个文件独立原子发布；不宣称跨文件系统原子性，失败时返回准确的逐文件状态并尽力回滚。
- `file_operation` 只处理路径结构；递归删除必须显式声明，移动和复制不得隐式覆盖目标。
- 所有输入、结果、文件数量、单文件大小、总修改大小和 prepared mutation 生命周期有界。

## 模型工具契约

### `read_file`

- 输入：`path`、`start_line?`、`line_count?`、`force?`。
- 行号从 1 开始，默认最多 2000 行；返回带行号正文、总行数、实际范围、`next_line`、截断和未变化状态。
- 仅接受普通 UTF-8 文本文件；二进制、设备和超限文件返回结构化错误。

### `find_files`

- 输入：`path?`、`glob?`、`recursive?`、`include_directories?`、`include_hidden?`、`offset?`、`limit?`。
- 非递归调用替代旧 `list_directory`，递归 glob 调用替代旧 `glob`。
- 返回统一的相对路径、类型、大小、分页和截断信息；遵守 ignore 与敏感路径规则。

### `grep`

- 输入：`pattern`、`path?`、`syntax?`、`case_insensitive?`、`include?`、`output?`、`context_lines?`、`offset?`、`limit?`。
- `syntax` 只允许 `literal|regex`；`output` 只允许 `content|files|count`。
- 返回有界分页结果，并报告跳过、截断和下一页位置。

### `write_file`

- 输入：`path`、`content`、`mode?`，默认 `create`。
- `create` 要求目标缺失；`rewrite` 要求目标存在且当前聊天已经读取相同版本。
- 自动创建缺失父目录，审批后仍使用条件写入拒绝并发覆盖。

### `apply_patch`

- 输入：`files[]`，每项包含 `path` 和非空 `edits[]`；每个 edit 包含 `old_text`、`new_text`、`replace_all?`。
- 支持单文件或多文件有序精确替换，不创建、删除、移动或全文重写文件。
- 未找到或非唯一匹配时返回位置和相似片段诊断，但不执行模糊替换。

### `file_operation`

- 使用封闭 `operation`：`move`、`copy`、`delete`、`create_directory`。
- `move|copy` 需要 `destination`，默认拒绝覆盖；`delete` 的目录递归删除需要 `recursive=true`；创建目录只用于显式空目录需求。
- 审批界面展示封闭操作和精确路径；批准后的执行仍在 Rust 中重新完成根目录、canonical path、目标占用和递归删除检查。

## 实施步骤

### 1. Rust Agent 文件服务

- [x] 新增统一 Agent 文件状态、owner 隔离、固定根目录授权和请求上限。
- [x] 将普通文件、最近存在祖先、符号链接和敏感路径检查落实到 Rust。
- [x] 复用现有 `fs` 与 `remote` primitive 路由 Local、WSL、SSH，不复制 Explorer 或 Editor 文件实现。
- [x] 为读取缓存、分页、路径越界、设备文件和会话清理添加测试。

验证：Rust 单元测试锁定所有 Workspace 共用的数据契约和安全不变量。

### 2. 读取、发现与搜索

- [x] 实现 `agent_file_read`，使用 1-based 行范围、稳定版本和 UTF-8 安全输出预算。
- [x] 实现 `agent_file_find`，统一直接目录列举和递归 glob，并在安全过滤后分页。
- [x] 实现 `agent_file_grep`，支持 literal/regex、三种输出、上下文和分页。
- [x] 删除前端读取哈希、路径安全过滤、结果裁剪和旧 `glob`/`list_directory` 调用。

验证：Local 真实文件测试及 WSL、SSH 路由协议测试覆盖分页、隐藏项、ignore 和敏感结果。

### 3. 写入、补丁与文件操作

- [x] 实现 `write_file` 的 create/rewrite prepared mutation，自动创建父目录并执行条件写入。
- [x] 实现多文件 `apply_patch` 的严格替换、read-before-edit、审批快照和版本冲突拒绝。
- [x] 实现 `file_operation` 的 move/copy/delete/create_directory，统一覆盖和递归删除规则。
- [x] 将 prepared mutation 状态移入 Rust，并在拒绝、终态、聊天删除和应用退出时清理。

验证：测试新建冲突、重写未读、审批后变化、多匹配、部分失败、符号链接换向、递归删除和目标占用。

### 4. 前端六工具切换

- [x] 用严格 Zod schema 暴露六个新工具，删除旧 builder、旧类型和兼容分支。
- [x] 更新审批 toast、diff 预览、工具进度、prompt、只读子 Agent 白名单和会话摘要。
- [x] 删除旧 `create_directory`、`edit`、`multi_edit`、`list_directory`、`glob` 渲染识别，不兼容旧历史记录。

验证：工具 schema、审批、native 映射、工具渲染和 prompt 测试只识别新工具。

### 5. 文档与清理

- [x] 更新 `AGENTS.md`、AI 子系统、安全模型、双进程命令参考和测试文档。
- [x] 全局搜索确认旧模型工具名、旧 IPC 和前端文件安全业务逻辑已删除。
- [x] 审核边界条件、并发、资源上限、重复逻辑和 nanobot 可吸收能力。

## 最终验证

1. `pnpm lint`
2. `pnpm check-types`
3. `pnpm test`
4. `cd src-tauri && cargo clippy --all-targets --locked -- -D warnings`
5. `cd src-tauri && cargo nextest run --locked`，本地没有 nextest 时使用 `cargo test --locked`
6. 条件允许时在真实 WSL 与 SSH Workspace 验证读取、发现、搜索、写入、补丁和文件树操作
7. `git diff --check` 与旧工具名、旧 IPC、em dash、文件级中文注释检查

## 完成标准

- 模型只看到六个新文件工具，没有旧名称或历史兼容层。
- 工具职责无明显重叠，常见读取、发现、搜索、创建、重写、局部编辑、移动、复制、删除和空目录操作都有明确入口。
- TypeScript 不再实现文件系统安全、版本和修改业务逻辑。
- Local、WSL、SSH 共享一个 Rust Agent 文件后端和一致契约。
- 审批内容、最终写入和文件版本一致，不能静默覆盖外部修改或跨越工作区与敏感路径边界。
- 相关代码和文档简洁、无兼容包袱，并通过最小且充分的完整检查。

## 验证记录

### 二次审核与 nanobot 对照

- 已吸收 nanobot 对 CRLF 精确替换、显式单文件 grep 和 128 个会话文件状态上限的处理，并保持 Terax 的 Rust 权威后端与 Local、WSL、SSH 一致契约。
- 修复 canonical 检查后仍沿可换向 symlink 路径执行正文 I/O 的竞态；授权结果现在同时保存稳定 I/O 路径，移动和删除最终 symlink 时仍只操作链接本身。
- 修复 SSH 存在性错误被当成目标缺失、本地 copy 目标竞态覆盖、WSL 与 SSH 路径在 Windows 宿主错误忽略大小写、CRLF 跨行补丁失败、结构操作审批遗漏 destination 等边界。
- 本地 copy 通过同目录临时文件和 no-clobber 发布，回滚新文件前验证当前内容版本，避免覆盖或删除并发写入。
- 未引入 nanobot 的模糊引号与缩进修复、`line_hint`、`occurrence` 和独立 `dry_run`。Terax 的严格唯一匹配、read-before-edit 与审批快照已经覆盖对应工作流，增加启发式分支会降低修改可预测性。
- 未增加 `find_files` 的 query、type、modified sort 或 `grep` 的参数别名。现有 glob、include、syntax 和 output 已覆盖核心能力，继续扩展同义参数会扩大 schema 并增加模型选择歧义。
- 未把图片、PDF 和 Office 提取并入 `read_file`。这些属于附件与文档解析能力，不应混入当前 UTF-8 工作区文件管理边界。

- `pnpm lint` 通过，保留仓库既有的 25 条 warning 和 2 条 info，没有新增本次变更告警。
- `pnpm check-types` 通过。
- `pnpm test` 通过，共 206 个测试文件、1053 个测试。
- `cargo clippy --all-targets --locked -- -D warnings` 通过。
- 本机没有 `cargo nextest`，回退的 `cargo test --locked` 通过，共 531 个单元测试、27 个文件搜索集成测试和 40 个 Git 集成测试。
- 新增 13 个 Rust Agent 文件测试，覆盖 owner scope 上限、已授权根、越界路径、敏感路径与 Windows 特殊路径、读取范围缓存、UTF-8 截断、CRLF 补丁、单文件 glob、目录发现、搜索上下文、no-clobber copy 和严格替换。
- Windows 宿主通过 `\\wsl.localhost` 对 Ubuntu 24.04 WSL 完成 symlink 物理路径、UTF-8、CRLF、移动、复制和删除真实验证。
- 使用已保存并可连接的真实 SSH profile，在其 Workspace 根内完成空目录创建、UTF-8/CRLF 写入与读取、LF 精确补丁、直接目录发现、显式单文件 grep、复制、移动和递归删除；随机探针目录已清理。既有 SFTP、远端 tree、grep 与条件写入协议测试继续覆盖降级路径。
