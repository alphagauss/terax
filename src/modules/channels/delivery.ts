/** 当前运行独占的投递出口；工具与最终回复共用队列，不等待 Agent 终态才消费。 */
import type {
  ChannelAdapter,
  ChannelInbound,
  ChannelOutbound,
  ChannelDeliveryResult,
  ChannelMessageSender,
} from "@/modules/channels/types";

const senders = new Map<string, ChannelMessageSender>();

export function getChannelMessageSender(
  sessionId: string,
): ChannelMessageSender | undefined {
  return senders.get(sessionId);
}

/** 每轮绑定不可变目标；释放时等待在途发送，旧工具闭包永久失效。 */
export function bindChannelDelivery(
  sessionId: string,
  adapter: ChannelAdapter,
  target: ChannelInbound,
  signal: AbortSignal,
) {
  let active = true;
  let accepted = false;
  let failed = false;
  let tail = Promise.resolve();
  const send = (
    input: ChannelOutbound,
    callSignal?: AbortSignal,
  ): Promise<ChannelDeliveryResult> => {
    const sending = tail.then(async () => {
      const combined = callSignal
        ? AbortSignal.any([signal, callSignal])
        : signal;
      if (!active || combined.aborted)
        throw new DOMException("Delivery cancelled", "AbortError");
      let result: ChannelDeliveryResult;
      try {
        result = await adapter.send(target, input, combined);
      } catch {
        combined.throwIfAborted();
        result = { status: "unknown", parts: [] };
      }
      if (result.parts.some((part) => part.status === "accepted"))
        accepted = true;
      if (result.status !== "accepted") failed = true;
      return result;
    });
    tail = sending.then(
      () => undefined,
      () => undefined,
    );
    return sending;
  };
  senders.set(sessionId, send);
  return {
    send,
    get accepted() {
      return accepted;
    },
    get failed() {
      return failed;
    },
    async close() {
      active = false;
      if (senders.get(sessionId) === send) senders.delete(sessionId);
      await tail;
    },
  };
}
