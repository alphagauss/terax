/**
 * 本文件测试 SSH 流量速率换算、单位格式化和状态栏采样。
 * 锁定累计值只通过相邻可见快照计算速率，并确保控件保持双向常驻显示。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environmentKind: "ssh",
  trafficSnapshot: vi.fn(),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => children,
  PopoverContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  PopoverTrigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string; profileId: string } }) => unknown,
  ) =>
    select({
      env: { kind: mocks.environmentKind, profileId: "server" },
    }),
}));
vi.mock("@/modules/remote/native", () => ({
  remoteNative: { trafficSnapshot: mocks.trafficSnapshot },
}));
vi.mock("@hugeicons/core-free-icons", () => ({
  ArrowDown01Icon: {},
  ArrowUp01Icon: {},
}));
vi.mock("@hugeicons/react", () => ({ HugeiconsIcon: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  calculateSshTrafficRate,
  formatSshTrafficBytes,
  SshTrafficControl,
} from "@/modules/remote/SshTrafficControl";

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.environmentKind = "ssh";
  mocks.trafficSnapshot.mockReset();
  document.body.innerHTML = "";
});

describe("SSH traffic calculations", () => {
  it("calculates monotonic byte deltas with the real elapsed interval", () => {
    expect(calculateSshTrafficRate(1_000, 3_048, 2_000)).toBe(1_024);
    expect(calculateSshTrafficRate(3_048, 1_000, 1_000)).toBe(0);
    expect(calculateSshTrafficRate(0, 1_000, 0)).toBe(0);
  });

  it("formats stable byte units for totals and rates", () => {
    expect(formatSshTrafficBytes(0)).toBe("0 B");
    expect(formatSshTrafficBytes(0.5)).toBe("1 B");
    expect(formatSshTrafficBytes(2_396_160)).toBe("2.29 MB");
    expect(formatSshTrafficBytes(12_345)).toBe("12.1 KB");
  });
});

describe("SSH traffic control", () => {
  it("does not mount the sampler in WSL workspaces", () => {
    mocks.environmentKind = "wsl";

    const { container, root } = render(createElement(SshTrafficControl));

    expect(container.innerHTML).toBe("");
    expect(mocks.trafficSnapshot).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("refreshes immediately when visibility returns during an in-flight sample", async () => {
    let visibility: DocumentVisibilityState = "visible";
    let resolveFirst: (value: {
      uploadedBytes: number;
      downloadedBytes: number;
    }) => void = () => undefined;
    const first = new Promise<{
      uploadedBytes: number;
      downloadedBytes: number;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    mocks.trafficSnapshot
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ uploadedBytes: 2_048, downloadedBytes: 4_096 });

    const { container, root } = render(createElement(SshTrafficControl));
    expect(mocks.trafficSnapshot).toHaveBeenCalledTimes(1);

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    resolveFirst({ uploadedBytes: 1_024, downloadedBytes: 2_048 });
    await act(async () => Promise.resolve());

    expect(mocks.trafficSnapshot).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("2.00 KB");
    expect(container.textContent).toContain("4.00 KB");
    act(() => root.unmount());
  });

  it("keeps both directions visible and derives the next one-second sample", async () => {
    vi.useFakeTimers();
    let sampledAt = 0;
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(performance, "now").mockImplementation(() => sampledAt);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    mocks.trafficSnapshot
      .mockResolvedValueOnce({ uploadedBytes: 1_000, downloadedBytes: 2_000 })
      .mockResolvedValueOnce({ uploadedBytes: 2_024, downloadedBytes: 4_048 })
      .mockResolvedValueOnce({ uploadedBytes: 3_048, downloadedBytes: 6_096 });

    const { container, root } = render(createElement(SshTrafficControl));
    await act(async () => Promise.resolve());
    expect(container.querySelector("button")?.textContent).toBe("0 B/s0 B/s");

    sampledAt = 1_000;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(container.querySelector("button")?.textContent).toBe(
      "1.00 KB/s2.00 KB/s",
    );
    expect(container.textContent).toContain("1.98 KB");
    expect(container.textContent).toContain("3.95 KB");

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(container.querySelector("button")?.textContent).toBe("0 B/s0 B/s");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(mocks.trafficSnapshot).toHaveBeenCalledTimes(2);

    visibility = "visible";
    sampledAt = 3_000;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(mocks.trafficSnapshot).toHaveBeenCalledTimes(3);
    expect(container.querySelector("button")?.textContent).toBe("0 B/s0 B/s");
    expect(container.textContent).toContain("2.98 KB");
    expect(container.textContent).toContain("5.95 KB");

    act(() => root.unmount());
  });
});
