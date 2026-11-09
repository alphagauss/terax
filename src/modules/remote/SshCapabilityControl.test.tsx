/**
 * 本文件测试状态栏能力浮窗的环境隔离、统一命令展示和手动重新检测。
 * 锁定旧连接事件不会污染当前状态，缺少 ripgrep 时必须呈现兼容模式与安装建议。
 */

// @vitest-environment happy-dom

import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  environmentKind: "ssh",
  distro: "Ubuntu",
  invoke: vi.fn(),
  runtime: {
    phase: "connected",
    version: 1,
    epoch: 7,
    profileId: "server",
    home: "/root",
  } as Record<string, unknown>,
  snapshot: vi.fn(),
  reprobe: vi.fn(),
  subscribe: vi.fn(),
  handler: null as ((snapshot: unknown) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children?: ReactNode }) => children,
  PopoverContent: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
  PopoverTrigger: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/modules/workspace", () => ({
  useWorkspaceEnvStore: (
    select: (state: {
      env: { kind: string; profileId: string; distro: string };
    }) => unknown,
  ) =>
    select({
      env: {
        kind: mocks.environmentKind,
        profileId: "server",
        distro: mocks.distro,
      },
    }),
}));
vi.mock("@/modules/remote/runtimeStore", () => ({
  useRemoteRuntimeStore: (select: (state: { snapshot: unknown }) => unknown) =>
    select({ snapshot: mocks.runtime }),
}));
vi.mock("@/modules/remote/native", () => ({
  remoteNative: {
    capabilitiesSnapshot: mocks.snapshot,
    reprobeCapabilities: mocks.reprobe,
    onCapabilities: mocks.subscribe,
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number>) =>
      values ? `${key}:${Object.values(values).join("/")}` : key,
  }),
}));

import { SshCapabilityControl } from "@/modules/remote/SshCapabilityControl";
import { WslCapabilityControl } from "@/modules/statusbar/WslCapabilityControl";

function capabilitySnapshot(epoch = 7) {
  return {
    epoch,
    state: "fallback",
    checkedAt: 10,
    commands: [
      { id: "find", command: "find -printf", state: "ready", detail: null },
      {
        id: "rg_content",
        command: "rg --json",
        state: "missing",
        detail: null,
      },
      { id: "grep", command: "grep -F", state: "ready", detail: null },
      {
        id: "python3_renameat2",
        command: "python3 / ctypes / renameat2",
        state: "ready",
        detail: null,
      },
    ],
    features: [
      {
        id: "content_search",
        state: "fallback",
        backend: "grep",
        commands: ["rg_content", "grep", "find"],
      },
      {
        id: "explorer_paste",
        state: "ready",
        backend: "bash",
        commands: ["python3_renameat2", "cp_archive", "mktemp", "rm"],
      },
    ],
  };
}

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

afterEach(() => {
  mocks.environmentKind = "ssh";
  mocks.distro = "Ubuntu";
  mocks.invoke.mockReset();
  mocks.runtime = {
    phase: "connected",
    version: 1,
    epoch: 7,
    profileId: "server",
    home: "/root",
  };
  mocks.snapshot.mockReset();
  mocks.reprobe.mockReset();
  mocks.subscribe.mockReset();
  mocks.handler = null;
  mocks.unlisten.mockReset();
  document.body.replaceChildren();
});

it("WSL 只渲染当前发行版报告，并能重新检测", async () => {
  mocks.environmentKind = "wsl";
  const report = {
    state: "unavailable",
    checkedAt: 10,
    commands: [
      {
        id: "python3_renameat2",
        command: "python3 / ctypes / renameat2",
        state: "missing",
        detail: null,
      },
    ],
    features: [
      {
        id: "explorer_paste",
        state: "unavailable",
        backend: null,
        commands: ["python3_renameat2"],
      },
    ],
  };
  mocks.invoke.mockResolvedValueOnce(report);
  mocks.invoke.mockResolvedValueOnce({
    ...report,
    state: "ready",
    commands: [{ ...report.commands[0], state: "ready" }],
    features: [{ ...report.features[0], state: "ready", backend: "bash" }],
  });
  const { container, root } = render(createElement(WslCapabilityControl));
  try {
    await act(async () => Promise.resolve());
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(
      "wsl_capabilities_probe",
    );
    expect(container.textContent).toContain("wslCapabilities.title");
    expect(container.textContent).toContain("wslCapabilities.nativePaste");
    expect(container.textContent).toContain(
      "sshCapabilities.commandStates.missing",
    );
    expect(container.textContent).not.toContain("ripgrepSuggestion");

    const button = [...container.querySelectorAll("button")].find(
      (item) => item.textContent === "sshCapabilities.recheck",
    );
    await act(async () => button?.click());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain(
      "sshCapabilities.commandStates.ready",
    );
    expect(container.textContent).not.toContain(
      "sshCapabilities.commandStates.missing",
    );
    mocks.environmentKind = "local";
    act(() => root.render(createElement(WslCapabilityControl)));
    expect(container.textContent).toBe("");
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  } finally {
    act(() => root.unmount());
  }
});

describe("SSH capability control", () => {
  it("shows command details and ignores stale epochs", async () => {
    mocks.subscribe.mockImplementation(async (handler) => {
      mocks.handler = handler;
      return mocks.unlisten;
    });
    mocks.snapshot.mockResolvedValue(capabilitySnapshot());
    const { container, root } = render(createElement(SshCapabilityControl));

    await act(async () => Promise.resolve());
    expect(container.textContent).toContain(
      "sshCapabilities.features.content_search",
    );
    expect(container.textContent).toContain("rg --json");
    expect(container.textContent).toContain(
      "sshCapabilities.features.explorer_paste",
    );
    expect(container.textContent).toContain("python3 / ctypes / renameat2");
    expect(container.textContent).toContain(
      "sshCapabilities.ripgrepSuggestion",
    );

    act(() => mocks.handler?.(capabilitySnapshot(6)));
    expect(container.textContent).toContain("grep -F");

    act(() => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("重检响应不能覆盖重连后的报告，新连接仍可重检", async () => {
    mocks.subscribe.mockImplementation(async (handler) => {
      mocks.handler = handler;
      return mocks.unlisten;
    });
    mocks.snapshot.mockResolvedValue(capabilitySnapshot());
    let finishOld!: (value: ReturnType<typeof capabilitySnapshot>) => void;
    mocks.reprobe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const ready = {
      ...capabilitySnapshot(8),
      state: "ready",
      commands: [
        {
          id: "rg_content",
          command: "rg --json",
          state: "ready",
          detail: null,
        },
      ],
      features: [
        {
          id: "content_search",
          state: "ready",
          backend: "rg",
          commands: ["rg_content"],
        },
      ],
    };
    mocks.reprobe.mockResolvedValueOnce(ready);
    const { container, root } = render(createElement(SshCapabilityControl));
    await act(async () => Promise.resolve());

    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "sshCapabilities.recheck",
    );
    act(() => button?.click());
    expect(mocks.reprobe).toHaveBeenCalledOnce();
    mocks.runtime = { ...mocks.runtime, epoch: 8 };
    mocks.snapshot.mockResolvedValue(ready);
    await act(async () => root.render(createElement(SshCapabilityControl)));
    await act(async () => finishOld(capabilitySnapshot(7)));
    expect(container.textContent).toContain("rg --json");
    expect(container.textContent).not.toContain("grep -F");
    expect(button?.disabled).toBe(false);

    await act(async () => button?.click());
    expect(mocks.reprobe).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("rg");
    expect(container.textContent).not.toContain(
      "sshCapabilities.ripgrepSuggestion",
    );

    act(() => root.unmount());
  });
});
