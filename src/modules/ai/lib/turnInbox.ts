/**
 * 本文件管理会话运行中的待接入消息。
 * 用户引导优先于后台结果且各自保持顺序；关闭接入与取消均同步裁决，不持久化未消费输入。
 */

import type {
  SubagentResultEvent,
  TurnEvent,
} from "@/modules/ai/lib/conversation";
import type { UIMessage } from "ai";

export type SteeringReceipt = Promise<"consumed" | "cancelled">;

/** 会话运行时拥有的优先队列，Subagent 只负责生产结果。 */
export class TurnInbox {
  private entries: Array<{
    event: TurnEvent;
    order?: number;
    settle?: (result: "consumed" | "cancelled") => void;
  }> = [];
  private listeners = new Set<() => void>();
  private accepting = false;

  get hasPending(): boolean {
    return this.entries.length > 0;
  }
  get pendingUsers(): number {
    return this.entries.filter((item) => item.event.event === "user_steering")
      .length;
  }
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
  open(): void {
    this.accepting = true;
  }
  close(): void {
    this.accepting = false;
  }

  /** 只有当前轮仍接收输入时才接受引导，调用方据此决定下一轮处理。 */
  steer(message: UIMessage): SteeringReceipt | null {
    if (!this.accepting) return null;
    let settle!: (result: "consumed" | "cancelled") => void;
    const receipt = new Promise<"consumed" | "cancelled">((resolve) => {
      settle = resolve;
    });
    this.entries.push({
      event: {
        event: "user_steering",
        message,
      },
      settle,
    });
    this.notify();
    return receipt;
  }

  /** 后台结果按任务创建序号入队，消费时可合并同批已完成结果。 */
  push(event: SubagentResultEvent, order: number): void {
    this.entries.push({ event, order });
    this.notify();
  }

  /** 用户消息之间保持 FIFO，后台完成结果只在没有用户引导时消费。 */
  take(): {
    event: TurnEvent;
    settle: (result: "consumed" | "cancelled") => void;
  } | null {
    if (!this.entries.length) return null;
    const user = this.entries.findIndex(
      (item) => item.event.event === "user_steering",
    );
    if (user < 0) {
      const entries = this.entries
        .splice(0)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      const event: SubagentResultEvent = {
        version: 1,
        event: "subagent_result",
        results: entries.flatMap((item) =>
          item.event.event === "subagent_result" ? item.event.results : [],
        ),
      };
      this.notify();
      return { event, settle: () => {} };
    }
    const entry = this.entries.splice(user, 1)[0];
    if (!entry) return null;
    this.notify();
    return { event: entry.event, settle: entry.settle ?? (() => {}) };
  }

  /** 等待后台任务时允许消息唤醒，离开等待立即注销监听。 */
  async waitUntil(task: Promise<void>): Promise<void> {
    if (this.hasPending) return;
    let unsubscribe = () => {};
    try {
      await Promise.race([
        task,
        new Promise<void>((resolve) => {
          unsubscribe = this.subscribe(resolve);
        }),
      ]);
    } finally {
      unsubscribe();
    }
  }

  /** 中止覆盖尚未消费的用户输入，已接入历史不回滚。 */
  cancel(): void {
    this.close();
    for (const entry of this.entries) entry.settle?.("cancelled");
    this.entries = [];
    this.notify();
  }
}
