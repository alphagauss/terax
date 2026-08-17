/**
 * 本文件测试 SSH Workspace 的首次后台连接策略。
 * 重点锁定事件桥就绪后只连接一次，且最终断开状态不会形成自动重试循环。
 */

// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceEnvironment } from "./useWorkspaceEnvironment";

let latestEnvironment: ReturnType<typeof useWorkspaceEnvironment> | null = null;

const mocks = vi.hoisted(() => ({
  env: { kind: "ssh", profileId: "server" } as const,
  snapshot: { phase: "idle", version: 0 } as Record<string, unknown>,
  applySnapshot: vi.fn(),
  onRuntime: vi.fn(),
  onHostKey: vi.fn(),
  pendingHostKey: vi.fn(),
  runtimeSnapshot: vi.fn(),
  wakeRuntime: vi.fn(),
  connectRuntime: vi.fn(),
  workspaceAuthorize: vi.fn(),
}));

vi.mock("@/modules/ai/lib/native", () => ({
  native: {
    workspaceAuthorize: mocks.workspaceAuthorize,
    workspaceCurrentDir: vi.fn(),
  },
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.env,
  getWslHome: vi.fn(),
}));

vi.mock("@tauri-apps/api/path", () => ({ homeDir: vi.fn() }));

vi.mock("@/modules/remote", () => {
  const runtimeState = () => ({
    snapshot: mocks.snapshot,
    applySnapshot: mocks.applySnapshot,
  });
  const useRemoteRuntimeStore = Object.assign(
    (selector: (state: ReturnType<typeof runtimeState>) => unknown) =>
      selector(runtimeState()),
    { getState: runtimeState },
  );
  return {
    connectedRuntimeHome: (snapshot: Record<string, unknown>) =>
      snapshot.phase === "connected" ? snapshot.home : null,
    remoteNative: {
      onRuntime: mocks.onRuntime,
      onHostKey: mocks.onHostKey,
      pendingHostKey: mocks.pendingHostKey,
      runtimeSnapshot: mocks.runtimeSnapshot,
      wakeRuntime: mocks.wakeRuntime,
      connectRuntime: mocks.connectRuntime,
    },
    useRemoteRuntimeStore,
    waitForRuntimeSettlement: vi.fn(async () => null),
  };
});

/** 挂载被测 Hook，使启动副作用按真实 React 生命周期执行。 */
function Harness() {
  latestEnvironment = useWorkspaceEnvironment();
  return null;
}

describe("useWorkspaceEnvironment", () => {
  const roots: ReturnType<typeof createRoot>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    latestEnvironment = null;
    mocks.snapshot = { phase: "idle", version: 0 };
    mocks.onRuntime.mockResolvedValue(() => {});
    mocks.onHostKey.mockResolvedValue(() => {});
    mocks.pendingHostKey.mockResolvedValue(null);
    mocks.runtimeSnapshot.mockImplementation(async () => mocks.snapshot);
    mocks.wakeRuntime.mockImplementation(async () => mocks.snapshot);
    mocks.connectRuntime.mockResolvedValue({
      phase: "connected",
      version: 1,
      epoch: 1,
      profileId: "server",
      home: "/home/developer",
    });
    mocks.applySnapshot.mockImplementation((snapshot) => {
      mocks.snapshot = snapshot;
    });
    mocks.workspaceAuthorize.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots.length = 0;
    document.body.replaceChildren();
  });

  async function renderHarness() {
    const root = createRoot(document.createElement("div"));
    roots.push(root);
    await act(async () => root.render(createElement(Harness)));
    for (let index = 0; index < 4; index += 1) {
      await act(async () => Promise.resolve());
    }
    return root;
  }

  it("connects once after registering the SSH event bridge", async () => {
    const root = await renderHarness();

    expect(mocks.connectRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.connectRuntime).toHaveBeenCalledWith("server", undefined);
    expect(mocks.onRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.connectRuntime.mock.invocationCallOrder[0],
    );
    expect(mocks.onHostKey.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.connectRuntime.mock.invocationCallOrder[0],
    );

    await act(async () => root.render(createElement(Harness)));
    expect(mocks.connectRuntime).toHaveBeenCalledTimes(1);
  });

  it("does not retry an initially disconnected Runtime", async () => {
    mocks.snapshot = {
      phase: "disconnected",
      version: 3,
      profileId: "server",
      reason: "authentication failed",
    };

    await renderHarness();

    expect(mocks.connectRuntime).not.toHaveBeenCalled();
  });

  it("asks Rust to verify a focused SSH window", async () => {
    await renderHarness();
    window.dispatchEvent(new Event("focus"));
    await act(async () => Promise.resolve());

    expect(mocks.wakeRuntime).toHaveBeenCalledTimes(1);
  });

  it("restores a host-key prompt created before event registration", async () => {
    mocks.snapshot = {
      phase: "connecting",
      version: 1,
      profileId: "server",
    };
    mocks.pendingHostKey.mockResolvedValue({
      requestId: "request",
      profileId: "server",
      host: "example.com",
      port: 22,
      keyType: "ssh-ed25519",
      fingerprint: "SHA256:test",
      changed: false,
    });

    await renderHarness();

    expect(latestEnvironment?.hostPrompt).toMatchObject({
      requestId: "request",
      profileId: "server",
    });
  });

  it("keeps the runtime bridge when pending host-key lookup fails", async () => {
    mocks.pendingHostKey.mockRejectedValue(new Error("IPC unavailable"));

    await renderHarness();

    expect(mocks.connectRuntime).toHaveBeenCalledOnce();
  });
});
