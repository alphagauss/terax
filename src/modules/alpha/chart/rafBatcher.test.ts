/**
 * 本文件测试图表动画帧批处理器。
 * 锁定同一帧只提交最后值，以及销毁时取消待处理更新。
 */

import { createRafBatcher } from "@/modules/alpha/chart/rafBatcher";
import { describe, expect, it, vi } from "vitest";

describe("createRafBatcher", () => {
  it("同一帧只提交最后一个值", () => {
    const callbacks: FrameRequestCallback[] = [];
    const flush = vi.fn();
    const batcher = createRafBatcher(
      flush,
      (next) => {
        callbacks.push(next);
        return 1;
      },
      vi.fn(),
    );

    batcher.schedule(1);
    batcher.schedule(2);
    callbacks[0]?.(0);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(2);
  });

  it("取消时丢弃待处理值", () => {
    const cancel = vi.fn();
    const flush = vi.fn();
    const batcher = createRafBatcher(flush, () => 7, cancel);

    batcher.schedule("pending");
    batcher.cancel();

    expect(cancel).toHaveBeenCalledWith(7);
    expect(flush).not.toHaveBeenCalled();
  });

  it("允许 undefined 作为合法的最后值提交", () => {
    const callbacks: FrameRequestCallback[] = [];
    const flush = vi.fn();
    const batcher = createRafBatcher<number | undefined>(flush, (next) => {
      callbacks.push(next);
      return 1;
    });

    batcher.schedule(1);
    batcher.schedule(undefined);
    callbacks[0]?.(0);

    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(undefined);
  });
});
