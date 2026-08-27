/**
 * 本文件测试 Alpha Panel Chrome 的跟随、固定和删除交互。
 * 重点锁定固定时复制当前主标的，恢复跟随后不保留面板私有标的。
 */

// @vitest-environment happy-dom

import { AlphaPanelChrome } from "@/modules/alpha/workstation/components/AlphaPanelChrome";
import type { AlphaPanelInstance } from "@/modules/alpha/workstation/model";
import { alphaPanelRegistry } from "@/modules/alpha/workstation/panelRegistry";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("AlphaPanelChrome", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;

  beforeEach(() => {
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  it("在 follow 与 pinned 间切换并触发删除", async () => {
    const onBindingChange = vi.fn();
    const onRemove = vi.fn();
    const panel: AlphaPanelInstance = {
      id: "chart-1",
      type: "chart",
      binding: { mode: "follow" },
      config: {},
    };

    await act(async () => {
      root?.render(
        <AlphaPanelChrome
          panel={panel}
          registry={alphaPanelRegistry}
          mainSymbol="000001.SZSE"
          onBindingChange={onBindingChange}
          onRemove={onRemove}
        />,
      );
    });

    const followButton = container.querySelector<HTMLButtonElement>(
      "button[aria-pressed='false']",
    );
    act(() => followButton?.click());
    expect(onBindingChange).toHaveBeenCalledWith({
      mode: "pinned",
      vtSymbol: "000001.SZSE",
    });

    await act(async () => {
      root?.render(
        <AlphaPanelChrome
          panel={{
            ...panel,
            binding: { mode: "pinned", vtSymbol: "600000.SSE" },
          }}
          registry={alphaPanelRegistry}
          mainSymbol="000001.SZSE"
          onBindingChange={onBindingChange}
          onRemove={onRemove}
        />,
      );
    });
    const pinnedButton = container.querySelector<HTMLButtonElement>(
      "button[aria-pressed='true']",
    );
    act(() => pinnedButton?.click());
    expect(onBindingChange).toHaveBeenLastCalledWith({ mode: "follow" });

    const removeButton = container.querySelector<HTMLButtonElement>(
      "button[aria-label='workstation.panel.remove']",
    );
    act(() => removeButton?.click());
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
