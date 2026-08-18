/**
 * 本文件测试状态栏 SSH RTT 与文件后端的 epoch 隔离和事件更新。
 * 锁定旧连接样本不能污染新 Runtime，且设置只更新当前原生文件后端。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  fileBackendSnapshot: vi.fn(),
  setFileBackendEnabled: vi.fn(),
  onFileBackend: vi.fn(),
  fileBackendHandler: null as ((snapshot: unknown) => void) | null,
  fileUnlisten: vi.fn(),
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
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (
    select: (state: { sshFileAcceleration: boolean; hydrated: boolean }) => unknown,
  ) => select({ sshFileAcceleration: true, hydrated: true }),
}));
vi.mock("@/modules/remote/native", () => ({
  remoteNative: {
    healthSnapshot: mocks.healthSnapshot,
    onHealth: mocks.onHealth,
    fileBackendSnapshot: mocks.fileBackendSnapshot,
    setFileBackendEnabled: mocks.setFileBackendEnabled,
    onFileBackend: mocks.onFileBackend,
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

beforeEach(() => {
  mocks.fileBackendSnapshot.mockResolvedValue({
    epoch: 7,
    capability: "unavailable",
    activeBackend: "sftp",
    pythonVersion: null,
    enabled: true,
    fallback: false,
    latencyEligible: false,
    rttThresholdMs: 100,
  });
  mocks.setFileBackendEnabled.mockResolvedValue({
    epoch: 7,
    capability: "unavailable",
    activeBackend: "sftp",
    pythonVersion: null,
    enabled: true,
    fallback: false,
    latencyEligible: false,
    rttThresholdMs: 100,
  });
  mocks.onFileBackend.mockImplementation(async (handler) => {
    mocks.fileBackendHandler = handler;
    return mocks.fileUnlisten;
  });
});

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
  mocks.fileBackendSnapshot.mockReset();
  mocks.fileBackendSnapshot.mockResolvedValue({
    epoch: 7,
    capability: "unavailable",
    activeBackend: "sftp",
    pythonVersion: null,
    enabled: true,
    fallback: false,
    latencyEligible: false,
    rttThresholdMs: 100,
  });
  mocks.setFileBackendEnabled.mockReset();
  mocks.setFileBackendEnabled.mockResolvedValue({
    epoch: 7,
    capability: "unavailable",
    activeBackend: "sftp",
    pythonVersion: null,
    enabled: true,
    fallback: false,
    latencyEligible: false,
    rttThresholdMs: 100,
  });
  mocks.onFileBackend.mockReset();
  mocks.onFileBackend.mockImplementation(async (handler) => {
    mocks.fileBackendHandler = handler;
    return mocks.fileUnlisten;
  });
  mocks.fileBackendHandler = null;
  mocks.fileUnlisten.mockReset();
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
    });
    const { container, root } = render(createElement(SshRttIndicator));

    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("-- ms");

    act(() => {
      mocks.healthHandler?.({ epoch: 6, rttMs: 999, sampledAt: 1 });
      mocks.healthHandler?.({ epoch: 7, rttMs: 268, sampledAt: 2 });
    });
    expect(container.textContent).toContain("268 ms");

    act(() => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("shows Python acceleration only for the current epoch", async () => {
    mocks.onHealth.mockResolvedValue(mocks.unlisten);
    mocks.healthSnapshot.mockResolvedValue({
      epoch: 7,
      rttMs: 200,
      sampledAt: 1,
    });
    const { container, root } = render(createElement(SshRttIndicator));
    await act(async () => Promise.resolve());

    act(() => {
      mocks.fileBackendHandler?.({
        epoch: 6,
        capability: "available",
        activeBackend: "python",
        pythonVersion: "3.12.1",
        enabled: true,
        fallback: false,
        latencyEligible: true,
        rttThresholdMs: 100,
      });
    });
    expect(container.textContent).not.toContain("I/O");

    act(() => {
      mocks.fileBackendHandler?.({
        epoch: 7,
        capability: "available",
        activeBackend: "python",
        pythonVersion: "3.12.1",
        enabled: true,
        fallback: false,
        latencyEligible: true,
        rttThresholdMs: 100,
      });
    });
    expect(container.textContent).toContain("I/O");
    expect(container.textContent).toContain("sshFileBackend.python");

    act(() => root.unmount());
    expect(mocks.fileUnlisten).toHaveBeenCalledOnce();
  });

  it("keeps SFTP active below the acceleration RTT threshold", async () => {
    mocks.onHealth.mockResolvedValue(mocks.unlisten);
    mocks.healthSnapshot.mockResolvedValue({
      epoch: 7,
      rttMs: 5,
      sampledAt: 1,
    });
    const { container, root } = render(createElement(SshRttIndicator));
    await act(async () => Promise.resolve());

    act(() => {
      mocks.fileBackendHandler?.({
        epoch: 7,
        capability: "available",
        activeBackend: "sftp",
        pythonVersion: "3.12.1",
        enabled: true,
        fallback: false,
        latencyEligible: false,
        rttThresholdMs: 100,
      });
    });

    expect(container.textContent).toContain("I/O");
    expect(container.textContent).toContain("sshFileBackend.lowLatency");
    act(() => root.unmount());
  });

  it("does not let a delayed initial snapshot replace a newer event", async () => {
    let resolveSnapshot!: (snapshot: {
      epoch: number;
      rttMs: null;
      sampledAt: null;
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
      mocks.healthHandler?.({ epoch: 7, rttMs: 268, sampledAt: 2 });
    });
    await act(async () => {
      resolveSnapshot({ epoch: 7, rttMs: null, sampledAt: null });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("268 ms");
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
