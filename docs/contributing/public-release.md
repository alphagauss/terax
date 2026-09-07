# public 发布流程

public 是排除 Alpha 的公共代码投影，日常开发只进入 main。公共与 Alpha 内容必须独立提交，Alpha 使用 alpha scope。

## 同步边界

每轮同步完成后用空提交记录已审查到的完整 main SHA：

```text
chore(public): record main sync point

Source-Main: <完整 main SHA>
```

该 SHA 包括已重放和明确跳过的提交，不等于最后一次 cherry-pick 来源。检查点不可改写，不使用同步 tag、Git notes 或 reflog 代替。

## 操作

1. 从 public 最近检查点取得 Source-Main，冻结本次目标 main SHA，按原始顺序审查范围内全部提交。
2. 公共提交使用 `git cherry-pick -x` 重放，Alpha 提交跳过。混杂提交先拆出公共部分并保留来源；scope 不能替代路径与 diff 审查。
3. 依赖和锁文件按公共投影生成，不能整体采用 main 锁文件。冲突修正只保留公共能力，不恢复 Alpha 类型、路由、依赖、翻译或文档入口。
4. 检查 public 不跟踪 Alpha 源码及专用文档，共享入口无 Alpha 残留，来源可追溯，工作区无意外修改。
5. 执行 [完整前端、Rust 检查与生产构建](testing.md)。依赖安装与使用同一 node_modules 的检查串行执行。
6. 全部修正和验证成功后创建上述空检查点，使用步骤 1 冻结的 SHA。再次确认提交正文与分支状态。

不得直接 merge、rebase main 或用 ours merge 记录同步，也不得为发布重写 main 历史。不能根据 public..main 判断待同步内容，因为 cherry-pick SHA 独立且 Alpha 始终留在差集。未完成验证不得写入新检查点。
