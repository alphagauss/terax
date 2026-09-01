# public 低频发布流程

本文定义从永久开发分支 `main` 生成低频公开发布分支 `public` 的固定流程。`public` 是经过审查的公共代码投影，不是第二条开发主干。

## 分支不变量

- 所有日常开发都进入 `main`。公共功能与 Alpha 功能必须保持独立提交。
- Alpha 功能、集成和专用基础设施提交必须使用 Conventional Commit 的 `alpha` scope。
- `public` 不得直接 merge 或 rebase `main`，否则会重新引入 Alpha 内容或把 Alpha 历史纳入公开分支祖先。
- 公共提交按 `main` 原始顺序使用 `git cherry-pick -x` 重放。`-x` trailer 保留单个提交的来源 SHA。
- `public` 可以包含解决公共投影冲突所需的专用修正，但每一处都必须能追溯到缺失的 Alpha 上下文或 public 发布不变量。
- 每次同步结束都使用 `chore(public): record main sync point` 空提交记录本次已经审查到的完整 `main` SHA，不使用同步 tag。

## 同步检查点

检查点固定使用以下格式：

```text
chore(public): record main sync point

Source-Main: <完整的 main commit SHA>
```

`Source-Main` 表示已经审查完毕的 main 边界，包括已重放的公共提交和已明确跳过的 Alpha 提交。它不要求对应提交出现在 `public` 历史中。

检查点必须位于当次 public 同步和验证修正之后。不要修改旧检查点，也不要用最后一个 cherry-pick 来源代替审查边界，因为 main 尾部可能只有被跳过的 Alpha 提交。

查看最近检查点：

```bash
git log public -1 --format=full --grep="^chore(public): record main sync point$"
```

## 发布步骤

### 1. 冻结来源边界

从最近检查点正文读取 `Source-Main`，并在开始时冻结本次目标 SHA：

```bash
git rev-parse main
git log --reverse --oneline <上次 Source-Main>..<本次目标 SHA>
```

发布过程中即使 `main` 继续前进，也只处理已经冻结的目标范围。

### 2. 审查新增提交

按时间顺序把范围内提交分为：

- 公共提交：完整重放。
- `alpha` scope 提交：跳过。
- 混杂提交：停止批量重放，拆出公共部分，并在 public 中形成可独立审查的提交。
- 依赖或锁文件提交：分别确认公共依赖和 Alpha 专用依赖，不能直接采用 main 的完整锁文件。

scope 只是第一层筛选。还必须检查修改路径和 diff，特别关注 `App.tsx`、Workbench 类型、Sidebar、设置、国际化、Tauri 注册入口、`Cargo.toml`、`Cargo.lock`、`package.json` 和 `pnpm-lock.yaml` 等共享边界。

非 `alpha` scope 提交触及 Alpha 路径，或 `alpha` scope 提交包含独立公共功能时，必须先修正 main 的提交纪律或在 public 中显式拆分，不能静默选择整项保留或丢弃。

### 3. 重放公共提交

切换到 public，从旧到新重放已经审核的公共提交：

```bash
git switch public
git cherry-pick -x <main commit SHA...>
```

冲突按“公共功能完整、Alpha 完全缺席”的原则解决。不得为了减少冲突恢复 Alpha 类型、路由、依赖、翻译、文档或运行时入口。

### 4. 清查公开投影

至少确认：

- 分支不跟踪 `alpha/`、`alpha-native/`、`src/modules/alpha/`、`src-tauri/src/modules/alpha/` 和 Alpha 架构文档。
- 共享入口不存在 Alpha import、命令注册、页面类型、Sidebar 容器、设置项或翻译键。
- 前端和 Rust 依赖中不存在仅由 Alpha 使用的包。
- 所有来源公共提交都能通过 `-x` trailer 或当次审查记录追溯，混杂提交的公共部分有独立提交。
- `git diff --check` 通过，工作区没有意外的已跟踪修改。

### 5. 验证

public 是跨前端和 Rust 的发布级重建，必须运行完整检查：

```bash
pnpm lint
pnpm check-types
pnpm test
pnpm build
cd src-tauri
cargo clippy --all-targets --locked -- -D warnings
cargo nextest run --locked
```

本地没有 nextest 时使用 `cargo test --locked`。依赖安装和 pnpm 检查必须串行执行，多个 pnpm 进程不得同时修改同一个 `node_modules`。

### 6. 写入检查点

所有重放、public 专用修正和验证完成后，使用步骤 1 冻结的完整目标 SHA 创建空提交：

```bash
git commit --allow-empty \
  -m "chore(public): record main sync point" \
  -m "Source-Main: <本次目标 SHA>"
```

检查点创建后再次确认提交正文、分支状态和目标 SHA。普通版本 tag 继续用于发布版本，不承担 main 同步状态。

## 禁止事项

- 不得为了同步 public 重写 `main` 历史。
- 不得使用 `git merge main`、`git rebase main` 或 `git merge -s ours main` 记录同步状态。
- 不得根据 `public..main` 直接判断未同步提交，因为 cherry-pick 后 SHA 独立，且 Alpha 提交会永久存在于该范围。
- 不得用可移动分支、Git notes、本地 reflog 或未推送 tag 作为唯一同步记录。
- 未完成完整验证时不得创建新的同步检查点或宣称已经审查到目标 SHA。
