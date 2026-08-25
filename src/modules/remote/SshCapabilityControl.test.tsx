/**
 * 本文件测试 SSH 能力灯的 epoch 隔离、统一命令展示和手动重新检测。
 * 锁定旧连接事件不会污染当前状态，缺少 ripgrep 时必须呈现兼容模式与安装建议。
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
  snapshot: vi.fn(),
  reprobe: vi.fn(),
  subscribe: vi.fn(),
  handler: null as ((snapshot: unknown) => void) | null,
  unlisten: vi.fn(),
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
  ) => select({ env: { kind: mocks.environmentKind, profileId: "server" } }),
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
    ],
    features: [
      {
        id: "content_search",
        state: "fallback",
        backend: "grep",
        commands: ["rg_content", "grep", "find"],
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
      "sshCapabilities.ripgrepSuggestion",
    );

    act(() => mocks.handler?.(capabilitySnapshot(6)));
    expect(container.textContent).toContain("grep -F");

    act(() => root.unmount());
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("replaces the snapshot after a manual recheck", async () => {
    mocks.subscribe.mockImplementation(async (handler) => {
      mocks.handler = handler;
      return mocks.unlisten;
    });
    mocks.snapshot.mockResolvedValue(capabilitySnapshot());
    mocks.reprobe.mockResolvedValue({
      ...capabilitySnapshot(),
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
    });
    const { container, root } = render(createElement(SshCapabilityControl));
    await act(async () => Promise.resolve());

    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === "sshCapabilities.recheck",
    );
    await act(async () => button?.click());
    expect(mocks.reprobe).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("rg");
    expect(container.textContent).not.toContain(
      "sshCapabilities.ripgrepSuggestion",
    );

    act(() => root.unmount());
  });
});
