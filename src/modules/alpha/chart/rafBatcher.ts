/**
 * 本文件提供按动画帧合并图表高频更新的轻量调度器。
 * 实现由 OpenTerminalUI 的 MIT rAF batcher 裁剪而来，仅保留最后值与可取消语义。
 */

type RequestFrame = (callback: FrameRequestCallback) => number;
type CancelFrame = (id: number) => void;

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window !== "undefined" && window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(
    () => callback(Date.now()),
    16,
  ) as unknown as number;
}

function cancelFrame(id: number): void {
  if (typeof window !== "undefined" && window.cancelAnimationFrame) {
    window.cancelAnimationFrame(id);
    return;
  }
  globalThis.clearTimeout(id);
}

/** 创建只在下一动画帧提交最后一个值的批处理器。 */
export function createRafBatcher<T>(
  onFlush: (value: T) => void,
  request: RequestFrame = requestFrame,
  cancel: CancelFrame = cancelFrame,
) {
  let frameId: number | null = null;
  let hasPendingValue = false;
  let pending: T;

  const flush = () => {
    if (!hasPendingValue) return;
    const value = pending;
    hasPendingValue = false;
    onFlush(value);
  };

  return {
    schedule(value: T) {
      pending = value;
      hasPendingValue = true;
      if (frameId !== null) return;
      frameId = request(() => {
        frameId = null;
        flush();
      });
    },
    cancel() {
      if (frameId !== null) cancel(frameId);
      frameId = null;
      hasPendingValue = false;
    },
  };
}
