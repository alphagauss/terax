/** 按一次模型执行管理 Shell 启动准入和取消；关闭准入后等待在途工具，再释放原生登记。 */
import { native } from "@/modules/ai/lib/native";

export class ShellExecution {
  readonly id = crypto.randomUUID();
  private opened?: Promise<void>;
  private stopping?: Promise<void>;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly ownerSessionId: string,
    private readonly signal?: AbortSignal,
    private readonly taskId?: string,
  ) {
    signal?.addEventListener("abort", this.abort, { once: true });
  }

  private readonly abort = () => {
    // 错误由收尾时的 stop/close 等待者接收，不产生未处理的 Promise。
    void this.stop().catch(() => {});
  };

  run<T>(execute: (executionId: string) => Promise<T>): Promise<T> {
    this.signal?.throwIfAborted();
    if (this.closing || this.stopping)
      throw new Error("Execution is stopping.");
    this.opened ??= native.shellOpenExecution(
      this.ownerSessionId,
      this.id,
      this.taskId,
    );
    const pending = this.opened.then(() => {
      this.signal?.throwIfAborted();
      if (this.closing || this.stopping)
        throw new Error("Execution is stopping.");
      return execute(this.id);
    });
    this.pending.add(pending);
    void pending.then(
      () => this.pending.delete(pending),
      () => this.pending.delete(pending),
    );
    return pending;
  }

  stop(): Promise<void> {
    this.stopping ??= this.opened
      ? this.opened.then(() =>
          native.shellStopExecution(this.ownerSessionId, this.id),
        )
      : Promise.resolve();
    return this.stopping;
  }

  close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    if (this.signal?.aborted) this.abort();
    await Promise.allSettled([...this.pending]);
    this.signal?.removeEventListener("abort", this.abort);
    const [stopped] = await Promise.allSettled([this.stopping]);
    if (this.opened) {
      await this.opened;
      await native.shellCloseExecution(this.ownerSessionId, this.id);
    }
    if (stopped.status === "rejected") throw stopped.reason;
  }
}
