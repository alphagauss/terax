# 终端 renderer pool

renderer pool 将 PTY 会话与昂贵的 xterm/WebGL 实例分离。容量、回收时机和缓冲实现以 `src/modules/terminal/lib/rendererPool.ts` 及相邻模块为准。

- 隐藏不等于停止会话。正在运行命令、Agent 或 alternate-screen TUI 的终端保留 live grid，不能序列化或驱逐。
- 该限制源自真实故障：在过时快照上重放 TUI 增量重绘会清空或破坏界面。
- 空闲终端可以释放绑定；保留的 live buffer 优先复用，避免重复回放快照。
- DormantRing 只为没有 slot 的终端保存有界输出；截断后的恢复不能从不完整转义序列中间开始。
- WebGL 生命周期可随可见性回收，但不能改变 PTY 与终端内容的归属。

终端身份和稳定页面实例见 [进程模型](two-process-model.md)。
