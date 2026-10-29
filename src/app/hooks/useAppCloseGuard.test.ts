// @vitest-environment happy-dom

/**
 * 本文件测试应用关闭守卫的保存时序。
 *
 * 锁定慢保存可取消、保存失败可强制退出，以及正常保存完成后才关闭窗口。
 */

import type { Tab } from "@/modules/workbench";
import { act, createElement, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AppCloseDialogState, useAppCloseGuard } from "./useAppCloseGuard";

const closeMocks = vi.hoisted(() => ({
  close: vi.fn(),
  countDirtyDocuments: vi.fn(),
  terminalNeedsCloseConfirmation: vi.fn(),
  listener: undefined as
    | ((event: { preventDefault: () => void }) => void)
    | undefined,
}));

vi.mock("@/modules/editor", () => ({
  countDirtyDocuments: closeMocks.countDirtyDocuments,
}));

vi.mock("@/modules/terminal", () => ({
  terminalNeedsCloseConfirmation: closeMocks.terminalNeedsCloseConfirmation,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: closeMocks.close,
    onCloseRequested: vi.fn(
      async (listener: (event: { preventDefault: () => void }) => void) => {
        closeMocks.listener = listener;
        return vi.fn();
      },
    ),
  }),
}));

type HarnessProps = {
  tabsRef: RefObject<Tab[]>;
  beforeClose: () => Promise<void>;
  saveAutoSaveDocuments: () => Promise<boolean>;
  onState: (value: {
    pendingAppClose: AppCloseDialogState | null;
    confirmAppClose: () => void;
    cancelAppClose: () => void;
  }) => void;
};

/** 暴露关闭守卫状态和操作，供测试驱动原生关闭事件。 */
function Harness({
  tabsRef,
  beforeClose,
  saveAutoSaveDocuments,
  onState,
}: HarnessProps) {
  onState(useAppCloseGuard(tabsRef, beforeClose, saveAutoSaveDocuments));
  return null;
}

describe("useAppCloseGuard", () => {
  let root: Root;
  let latest:
    | {
        pendingAppClose: AppCloseDialogState | null;
        confirmAppClose: () => void;
        cancelAppClose: () => void;
      }
    | undefined;
  const tabsRef = { current: [] } as RefObject<Tab[]>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    tabsRef.current = [];
    closeMocks.listener = undefined;
    closeMocks.close.mockResolvedValue(undefined);
    closeMocks.countDirtyDocuments.mockReturnValue(0);
    closeMocks.terminalNeedsCloseConfirmation.mockResolvedValue(false);
    root = createRoot(document.createElement("div"));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
  });

  async function renderHarness(
    beforeClose: () => Promise<void>,
    saveAutoSaveDocuments: () => Promise<boolean>,
  ) {
    await act(async () => {
      root.render(
        createElement(Harness, {
          tabsRef,
          beforeClose,
          saveAutoSaveDocuments,
          onState: (value) => {
            latest = value;
          },
        }),
      );
    });
  }

  async function requestClose() {
    await act(async () => {
      await closeMocks.listener?.({ preventDefault: vi.fn() });
    });
  }

  it("等待自动保存和状态持久化完成后才关闭", async () => {
    const calls: string[] = [];
    await renderHarness(
      async () => {
        calls.push("state");
      },
      async () => {
        calls.push("documents");
        return true;
      },
    );

    await requestClose();
    await vi.waitFor(() => expect(closeMocks.close).toHaveBeenCalledOnce());
    expect(calls).toEqual(["documents", "state"]);
  });

  it.each([false, true])(
    "终端关闭保护结果为 %s 时保持退出确认一致",
    async (needsConfirmation) => {
      tabsRef.current = [
        {
          id: 7,
          kind: "terminal",
          spaceId: "default",
          title: "Terminal",
        } as Tab,
      ];
      closeMocks.terminalNeedsCloseConfirmation.mockResolvedValue(
        needsConfirmation,
      );
      await renderHarness(
        async () => {},
        async () => false,
      );
      await requestClose();
      expect(closeMocks.terminalNeedsCloseConfirmation.mock.calls[0]?.[0]).toBe(
        7,
      );
      if (needsConfirmation) {
        expect(latest?.pendingAppClose).toEqual({
          kind: "blocker",
          dirtyEditors: 0,
          busyTerminal: true,
        });
        expect(closeMocks.close).not.toHaveBeenCalled();
      } else {
        expect(closeMocks.close).toHaveBeenCalledOnce();
      }
    },
  );

  it("保存超过三秒时允许取消关闭等待", async () => {
    let releaseSave: (() => void) | undefined;
    const saving = new Promise<boolean>((resolve) => {
      releaseSave = () => resolve(true);
    });
    await renderHarness(
      async () => {},
      () => saving,
    );

    await requestClose();
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(latest?.pendingAppClose).toEqual({ kind: "saving" });

    act(() => latest?.cancelAppClose());
    releaseSave?.();
    await act(async () => {
      await Promise.resolve();
    });
    expect(latest?.pendingAppClose).toBeNull();
    expect(closeMocks.close).not.toHaveBeenCalled();
  });

  it("保存失败时展示原因并允许强制关闭", async () => {
    await renderHarness(
      async () => {},
      async () => {
        throw new Error("disk full");
      },
    );

    await requestClose();
    await vi.waitFor(() =>
      expect(latest?.pendingAppClose).toEqual({
        kind: "failed",
        reason: "disk full",
      }),
    );

    act(() => latest?.confirmAppClose());
    expect(closeMocks.close).toHaveBeenCalledOnce();
  });

  it("确认忽略未保存文件后仍会持久化状态再关闭", async () => {
    closeMocks.countDirtyDocuments.mockReturnValue(1);
    const beforeClose = vi.fn().mockResolvedValue(undefined);
    await renderHarness(beforeClose, async () => false);

    await requestClose();
    await vi.waitFor(() =>
      expect(latest?.pendingAppClose).toEqual({
        kind: "blocker",
        dirtyEditors: 1,
        busyTerminal: false,
      }),
    );

    act(() => latest?.confirmAppClose());
    await vi.waitFor(() => expect(closeMocks.close).toHaveBeenCalledOnce());
    expect(beforeClose).toHaveBeenCalledOnce();
  });
});
