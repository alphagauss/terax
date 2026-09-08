/**
 * 本文件在 SDK 消息复制前合并连续文本增量。
 * 仅合并同一片段和元数据的正文或推理，协议边界立即冲刷，消费取消会释放上游读取。
 */
import type { UIMessageChunk } from "ai";
import { STREAM_RENDER_INTERVAL_MS } from "@/modules/ai/lib/chatRendering";

type TextDelta = Extract<
  UIMessageChunk,
  { type: "text-delta" | "reasoning-delta" }
>;

/** 保留首个增量的响应速度，并对后续增量提供时间和大小双重上限。 */
export function coalesceStream(
  source: ReadableStream<UIMessageChunk>,
): ReadableStream<UIMessageChunk> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  async function* chunks(): AsyncGenerator<UIMessageChunk> {
    let pending: TextDelta | undefined;
    let next = reader.read();
    let deadline = 0;
    try {
      while (!cancelled) {
        const value = pending
          ? await Promise.race([
              next,
              new Promise<null>((resolve) => {
                timer = setTimeout(
                  () => resolve(null),
                  Math.max(0, deadline - Date.now()),
                );
              }),
            ])
          : await next;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (cancelled) return;
        if (value === null) {
          if (pending) yield pending;
          pending = undefined;
          deadline = Date.now() + STREAM_RENDER_INTERVAL_MS;
          continue;
        }
        if (value.done) break;
        const chunk = value.value;
        // 在消费当前事件前启动一次读取，始终只允许一个未完成的 read。
        next = reader.read();
        // 下次读取可能在生成器暂停期间失败，错误仍由 await next 按顺序传播。
        void next.catch(() => {});
        if (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta") {
          if (pending) yield pending;
          pending = undefined;
          yield chunk;
          continue;
        }
        if (
          pending &&
          (pending.type !== chunk.type ||
            pending.id !== chunk.id ||
            pending.providerMetadata !== chunk.providerMetadata)
        ) {
          yield pending;
          pending = undefined;
        }
        pending = pending
          ? { ...pending, delta: pending.delta + chunk.delta }
          : { ...chunk };
        if (Date.now() >= deadline || pending.delta.length >= 8192) {
          yield pending;
          pending = undefined;
          deadline = Date.now() + STREAM_RENDER_INTERVAL_MS;
        }
      }
      if (pending) yield pending;
    } catch (error) {
      if (pending && !cancelled) yield pending;
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const iterator = chunks();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (cancelled) return;
        if (item.done) controller.close();
        else controller.enqueue(item.value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      await reader.cancel(reason).catch(() => {});
      await iterator.return(undefined);
      // 首次 pull 前取消时，生成器尚未进入 finally。
      reader.releaseLock();
    },
  });
}
