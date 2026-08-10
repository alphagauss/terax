# 终端 renderer pool

本指南是对 `AGENTS.md` 的补充。如有冲突，以 `AGENTS.md` 为准。

## 为什么需要 pool

切换终端 tab 时，tab 会保持挂载并隐藏，使 PTY 和开发服务器能够继续在后台输出。如果创建无限数量的 xterm + WebGL renderer 实例，将会超出内存预算，因此 Terax 使用 renderer slot pool。

pool 位于 `src/modules/terminal/lib/rendererPool.ts`。

前端终端 identity 是所属 Workbench tab 的 `tab.id`。`TerminalTab` 不存储第二个 runtime ID。终端代码将同一个值命名为 `terminalId` 以明确局部 domain，而原生 PTY 保留自己独立的 ID。

## Slot 生命周期

- `POOL_MAX_SIZE` 为 5（`rendererPool.ts:22`）。每个 slot 拥有一个 xterm `Terminal`、`FitAddon`、`SearchAddon`、`SerializeAddon`，以及可选的 `WebglAddon`。
- slot 按需创建，并在 bind 时分配给终端。
- `releaseSlot` 将 slot 与终端分离。如果终端处于 idle 状态，该 slot 会以 `display:none` 停放，使 xterm 停止渲染但继续解析 PTY 字节。
- 经过 grace period 后，可以回收 idle slot 以控制 pool 大小。

## 停放与释放

终端隐藏时：

1. `parkTerminalSlot` 将 host 设为 `display:none`。渲染暂停，但 live buffer 继续接收字节。
2. 如果终端处于 **busy** 状态（前台命令、Agent signal、alt-screen TUI 或 block-shell running mode），它会无限期保持 slot 停放。
3. 如果终端处于 **idle** 状态，则在 `HIDDEN_RELEASE_DELAY_MS` 后调用 `releaseSlot`。slot 的 `currentTerminalId` 会被清除，同时设置 `retainedTerminalId`，使 buffer 保持活动。

终端再次可见时，`acquireSlot` 按以下顺序查找：

1. 已经 bind 到该终端的 slot。
2. 为该终端保留的 slot（`retainedTerminalId === terminalId`），这是无需重放 snapshot 的 fast path。
3. 干净的 idle slot。
4. 如果 pool 已达到最大容量，则驱逐评分最低的 slot。驱逐会先通过 `SerializeAddon` 将保留的 buffer 序列化为 snapshot，再占用该 slot。

## DormantRing

`src/modules/terminal/lib/dormantRing.ts` 为完全没有 slot（被占用或从未 bind）的终端缓冲 PTY 字节。其容量上限为 1 MiB，溢出时丢弃最早的 block。drain 时从下一个行边界恢复，而不是重置终端，从而避免从中间位置重放不完整的 escape sequence。

## 禁止在命令执行中序列化的不变量

这是 pool 中最重要的规则。正在执行命令的终端绝不能被序列化。在过时 snapshot 上重放增量 TUI repaint 曾导致 Claude Code 界面被清空。

代码通过在驱逐前检查 `isTerminalBusy`，并在 `commandRunning`、`isAgentActivePty` 或 alt-screen 为 true 时仅停放而不释放 slot，来保证该规则。

## Fast path 与 snapshot 重放

如果终端存在 retained slot，`bindSlot` 会跳过 `term.clear()` / `term.reset()`，只将 DormantRing drain 到 live buffer 中，从而避免重新渲染大型 snapshot。

如果只存在 snapshot，`bindSlot` 会清空终端、调整尺寸、写入 snapshot，然后 drain ring。对于 alt-screen TUI，会跳过 snapshot 并发送 SIGWINCH 触发，使 TUI 从头 repaint。

## WebGL 生命周期

slot 可见时创建 WebGL addon，停放后经过 grace period 再回收。addon 能从休眠/唤醒或 GPU reset 引起的 context loss 中恢复。

## 不变量

- pool 绝不能无限增长，最大容量为 `POOL_MAX_SIZE`。
- 绝不序列化或驱逐正在执行命令或处于 alt-screen 的终端。
- 隐藏的 busy 终端以 `display:none` 保持其 live grid 停放。
- 隐藏的 idle 终端释放其 slot，但 buffer 继续解析字节。
- DormantRing 只为没有任何 slot 的终端缓冲字节。

## 另请参阅

- [`AGENTS.md`](../../AGENTS.md) - 架构权威文档
- [`docs/README.md`](../README.md) - 贡献者指南索引
- [PTY Shell 集成](pty-shell-integration.md) - session、OSC sequence 和 ConPTY
