/**
 * 本文件管理会话运行中的待接入消息。
 * 用户引导优先于后台结果且各自保持顺序；关闭接入与取消均同步裁决，不持久化未消费输入。
 */
import type { UIMessage } from "ai";
import type { SubagentResultEvent } from "@/modules/ai/agents/subagentRuntime";

export type SteeringEvent = { event: "user_steering"; message: UIMessage };
export type TurnEvent = SteeringEvent | SubagentResultEvent;
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
        message: {
          ...message,
          metadata: { ...(message.metadata as object), guided: true },
        },
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

/** 读取内部引导 part，正文与媒体保持真实用户消息结构。 */
export function isSteeringPart(
  part: unknown,
): part is { type: "data-user-steering"; data: SteeringEvent } {
  const value = part as { type?: unknown; data?: SteeringEvent } | null;
  return (
    value?.type === "data-user-steering" &&
    value.data?.event === "user_steering" &&
    value.data.message?.role === "user" &&
    Array.isArray(value.data.message.parts)
  );
}

/** 展示层按引导消息切开活动，原始 Chat 流仍由一个运行锁管理。 */
export function projectSteeredMessages(
  messages: readonly UIMessage[],
): UIMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant" || !message.parts.some(isSteeringPart))
      return [message];
    const result: UIMessage[] = [];
    let parts: UIMessage["parts"] = [];
    let id = message.id;
    // 后台结果和终态快照可能晚于引导到达，仍供前面所属的 Subagent 卡片消费。
    const background = message.parts.filter(
      (part) =>
        part.type === "data-subagent-result" ||
        part.type === "data-subagent-display",
    );
    const segment = (): UIMessage => ({
      ...message,
      id,
      parts: parts.some(
        (part) =>
          part.type === "tool-run_subagent" ||
          (part.type === "dynamic-tool" && part.toolName === "run_subagent"),
      )
        ? [...parts, ...background]
        : parts,
    });
    for (const part of message.parts) {
      if (
        part.type === "data-subagent-result" ||
        part.type === "data-subagent-display"
      )
        continue;
      if (!isSteeringPart(part)) {
        parts.push(part);
        continue;
      }
      if (parts.length) result.push(segment());
      result.push({
        ...part.data.message,
        metadata: { ...(part.data.message.metadata as object), guided: true },
      });
      id = `${message.id}:after:${part.data.message.id}`;
      parts = [];
    }
    result.push(segment());
    return result;
  });
}
