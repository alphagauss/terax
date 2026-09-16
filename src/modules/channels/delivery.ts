/** 当前运行的目标绑定与回执统计；实际投递顺序由实例运行时统一管理。 */
import { ChannelError } from "@/modules/channels/types";
import type {
  ChannelDeliverySource,
  ChannelTarget,
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
  dispatch: (
    target: ChannelTarget,
    content: ChannelOutbound,
    signal: AbortSignal,
    source: ChannelDeliverySource,
  ) => Promise<ChannelDeliveryResult>,
  target: ChannelTarget,
  signal: AbortSignal,
) {
  let active = true;
  let accepted = false;
  const pending = new Set<Promise<ChannelDeliveryResult>>();
  const sendTo = (
    input: ChannelOutbound,
    callSignal?: AbortSignal,
    source: ChannelDeliverySource = "tool",
  ): Promise<ChannelDeliveryResult> => {
    const sending = (async () => {
      const combined = callSignal
        ? AbortSignal.any([signal, callSignal])
        : signal;
      if (!active || combined.aborted)
        throw new DOMException("Delivery cancelled", "AbortError");
      let result: ChannelDeliveryResult;
      try {
        result = await dispatch(target, input, combined, source);
      } catch (error) {
        if (error instanceof ChannelError && error.issue === "storage")
          throw error;
        combined.throwIfAborted();
        result = { status: "unknown", parts: [] };
      }
      // 投递记录可以在取消后补写，但不能吞掉工具调用的取消信号。
      combined.throwIfAborted();
      if (
        source !== "command" &&
        result.parts.some((part) => part.status === "accepted")
      )
        accepted = true;
      return result;
    })();
    pending.add(sending);
    void sending.finally(() => pending.delete(sending)).catch(() => {});
    return sending;
  };
  const send: ChannelMessageSender = (input, callSignal) =>
    sendTo(input, callSignal);
  senders.set(sessionId, send);
  return {
    send,
    reply: (text: string) => sendTo({ text }, undefined, "command"),
    final: (text: string) => sendTo({ text }, undefined, "agent"),
    get accepted() {
      return accepted;
    },
    async close() {
      active = false;
      if (senders.get(sessionId) === send) senders.delete(sessionId);
      await Promise.allSettled([...pending]);
    },
  };
}
