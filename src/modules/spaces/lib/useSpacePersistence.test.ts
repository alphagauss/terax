// @vitest-environment happy-dom

/**
 * 本文件测试 Space 布局持久化 Hook。
 *
 * 重点锁定主动关闭刷新会绕过防抖，并等待相同布局的在途写入完成。
 */

import type { WorkbenchState } from "@/modules/workbench";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpacePersistence } from "./useSpacePersistence";

const persistence = vi.hoisted(() => ({
  saveState: vi.fn(),
}));

vi.mock("@/modules/spaces/lib/serialize", () => ({
  serializeSpaceWorkbench: (state: { serialized: unknown }) => state.serialized,
}));

vi.mock("@/modules/spaces/lib/store", () => ({
  saveState: persistence.saveState,
}));

type HarnessProps = {
  state: WorkbenchState;
  onFlushReady: (flush: () => Promise<void>) => void;
};

/**
 * 暴露 Hook 返回的立即刷新函数，供测试驱动关闭时序。
 */
function Harness({ state, onFlushReady }: HarnessProps) {
  onFlushReady(useSpacePersistence({ state, enabled: true }));
  return null;
}

describe("useSpacePersistence", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  it("立即刷新会绕过防抖并等待相同布局的在途写入", async () => {
    let releaseWrite: (() => void) | undefined;
    persistence.saveState.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseWrite = resolve;
        }),
    );
    const state = {
      spaces: { "space-a": {} },
      serialized: { kind: "group", tabs: [], activeTabIndex: -1 },
    } as unknown as WorkbenchState;
    let flushImmediately: (() => Promise<void>) | undefined;

    await act(async () => {
      root.render(
        createElement(Harness, {
          state,
          onFlushReady: (flush) => {
            flushImmediately = flush;
          },
        }),
      );
    });

    expect(persistence.saveState).not.toHaveBeenCalled();
    const firstFlush = flushImmediately?.();
    const secondFlush = flushImmediately?.();
    await Promise.resolve();

    expect(persistence.saveState).toHaveBeenCalledTimes(1);
    let secondCompleted = false;
    void secondFlush?.then(() => {
      secondCompleted = true;
    });
    await Promise.resolve();
    expect(secondCompleted).toBe(false);

    releaseWrite?.();
    await expect(firstFlush).resolves.toBeUndefined();
    await expect(secondFlush).resolves.toBeUndefined();
    expect(secondCompleted).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(persistence.saveState).toHaveBeenCalledTimes(1);
  });

  it("零标签 Space 会保存显式空态", async () => {
    persistence.saveState.mockResolvedValue(undefined);
    const state = {
      spaces: { "space-a": {} },
      serialized: null,
    } as unknown as WorkbenchState;
    let flushImmediately: (() => Promise<void>) | undefined;

    await act(async () => {
      root.render(
        createElement(Harness, {
          state,
          onFlushReady: (flush) => {
            flushImmediately = flush;
          },
        }),
      );
    });

    await flushImmediately?.();
    expect(persistence.saveState).toHaveBeenCalledWith("space-a", {
      version: 2,
      workbench: null,
    });
  });

  it("回到空态时排在仍在写入的非空布局之后保存", async () => {
    let releaseWrite!: () => void;
    const writing = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    persistence.saveState
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(writing)
      .mockReturnValueOnce(writing.then(() => undefined));

    let flush!: () => Promise<void>;
    function renderLayout(serialized: unknown) {
      const state = {
        spaces: { "space-a": {} },
        serialized,
      } as unknown as WorkbenchState;
      act(() =>
        root.render(
          createElement(Harness, {
            state,
            onFlushReady: (ready) => {
              flush = ready;
            },
          }),
        ),
      );
    }

    const nonempty = {
      kind: "group",
      tabs: [{ kind: "terminal" }],
      activeTabIndex: 0,
    };
    renderLayout(null);
    await flush();
    renderLayout(nonempty);
    const pending = flush();
    renderLayout(null);
    const clearing = flush();

    expect(persistence.saveState.mock.calls).toEqual([
      ["space-a", { version: 2, workbench: null }],
      ["space-a", { version: 2, workbench: nonempty }],
      ["space-a", { version: 2, workbench: null }],
    ]);
    releaseWrite();
    await Promise.all([pending, clearing]);
  });
});
