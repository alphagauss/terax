/**
 * 本文件测试状态栏 SSH RTT 的 epoch 隔离、事件更新和写入降级提示。
 * 锁定旧连接样本不能污染新 Runtime，且永久回退只在当前 epoch 显示 I/O 标记。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environmentKind: "ssh",
  runtime: {
    phase: "connected",
    version: 1,
    epoch: 7,
    profileId: "server",
    home: "/root",
  } as Record<string, unknown>,
  healthSnapshot: vi.fn(),
  onHealth: vi.fn(),
  healthHandler: null as ((snapshot: unknown) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => children,
  TooltipContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: { env: { kind: string; profileId: string } }) => unknown,
  ) =>
    select({
      env: { kind: mocks.environmentKind, profileId: "server" },
    }),
}));
vi.mock("@/modules/remote/runtimeStore", () => ({
  useRemoteRuntimeStore: (select: (state: { snapshot: unknown }) => unknown) =>
    select({ snapshot: mocks.runtime }),
}));
vi.mock("@/modules/remote/native", () => ({
  remoteNative: {
    healthSnapshot: mocks.healthSnapshot,
    onHealth: mocks.onHealth,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { value?: string | number }) =>
      values?.value === undefined ? key : `${key}:${values.value}`,
  }),
}));

import { SshRttIndicator } from "@/modules/remote/SshRttIndicator";

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

afterEach(() => {
  mocks.environmentKind = "ssh";
  mocks.runtime = {
    phase: "connected",
    version: 1,
    epoch: 7,
    profileId: "server",
    home: "/root",
  };
  mocks.healthSnapshot.mockReset();
  mocks.onHealth.mockReset();
  mocks.healthHandler = null;
  mocks.unlisten.mockReset();
  document.body.replaceChildren();
});

describe("SSH RTT indicator", () => {
  it("shows the current epoch sample and ignores stale events", async () => {
    mocks.onHealth.mockImplementation(async (handler) => {
      mocks.healthHandler = handler;
      return mocks.unlisten;
    });
    mocks.healthSnapshot.mockResolvedValue({
      epoch: 7,
      rttMs: null,
      sampledAt: null,
      fileWriteFallback: false,
    });
    const { container, root } = render(createElement(SshRttIndicator));

    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("-- ms");

    act(() => {
      mocks.healthHandler?.({
        epoch: 6,
        rttMs: 999,
        sampledAt: 1,
        fileWriteFallback: true,
      });
      mocks.healthHandler?.({
        epoch: 7,
        rttMs: 268,
        sampledAt: 2,
        fileWriteFallback: false,
      });
    });
    expect(container.textContent).toContain("268 ms");

    act(() => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("does not let a delayed initial snapshot replace a newer event", async () => {
    let resolveSnapshot!: (snapshot: {
      epoch: number;
      rttMs: null;
      sampledAt: null;
      fileWriteFallback: false;
    }) => void;
    mocks.onHealth.mockImplementation(async (handler) => {
      mocks.healthHandler = handler;
      return mocks.unlisten;
    });
    mocks.healthSnapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    const { container, root } = render(createElement(SshRttIndicator));

    await act(async () => Promise.resolve());
    act(() => {
      mocks.healthHandler?.({
        epoch: 7,
        rttMs: 268,
        sampledAt: 2,
        fileWriteFallback: false,
      });
    });
    await act(async () => {
      resolveSnapshot({
        epoch: 7,
        rttMs: null,
        sampledAt: null,
        fileWriteFallback: false,
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("268 ms");
    act(() => root.unmount());
  });

  it("shows I/O only after the current epoch permanently falls back", async () => {
    mocks.onHealth.mockImplementation(async (handler) => {
      mocks.healthHandler = handler;
      return mocks.unlisten;
    });
    mocks.healthSnapshot.mockResolvedValue({
      epoch: 7,
      rttMs: 20,
      sampledAt: 1,
      fileWriteFallback: false,
    });
    const { container, root } = render(createElement(SshRttIndicator));

    await act(async () => Promise.resolve());
    expect(container.textContent).not.toContain("I/O");

    act(() => {
      mocks.healthHandler?.({
        epoch: 7,
        rttMs: 20,
        sampledAt: 1,
        fileWriteFallback: true,
      });
    });
    expect(container.textContent).toContain("I/O");
    expect(container.textContent).toContain("sshRtt.fileWriteFallback");

    mocks.runtime = {
      phase: "connected",
      version: 2,
      epoch: 8,
      profileId: "server",
      home: "/root",
    };
    mocks.healthSnapshot.mockResolvedValue({
      epoch: 8,
      rttMs: 21,
      sampledAt: 2,
      fileWriteFallback: false,
    });
    await act(async () => {
      root.render(createElement(SshRttIndicator));
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("I/O");

    act(() => root.unmount());
  });

  it("does not subscribe outside a connected SSH Runtime", () => {
    mocks.environmentKind = "local";
    mocks.runtime = { phase: "idle", version: 2 };

    const { container, root } = render(createElement(SshRttIndicator));

    expect(container.innerHTML).toBe("");
    expect(mocks.onHealth).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
