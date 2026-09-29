// @vitest-environment happy-dom
/**
 * 本文件测试 Workbench 向 AI 发布草稿工作目录的延迟准备逻辑。
 * 锁定隐藏面板不创建目录、无根时使用默认目录且 Explorer 根始终优先。
 */

import type { TerminalPaneHandle } from "@/modules/terminal";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareDefaultWorkspaceRoot: vi.fn(),
  invoke: vi.fn(),
  toastError: vi.fn(),
  workspaceKind: "local",
}));

vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: mocks.workspaceKind }),
  prepareDefaultWorkspaceRoot: mocks.prepareDefaultWorkspaceRoot,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: mocks.toastError } }));
vi.mock("./native", () => ({
  native: { workspaceAuthorize: vi.fn() },
}));

import type { Live } from "../store/chatStore";
import { useAiLiveBridge } from "./useAiLiveBridge";

function Harness({
  explorerRoot,
  visible,
  setLive,
  environmentHome = null,
}: {
  explorerRoot: string | null;
  visible: boolean;
  setLive: (live: Live) => void;
  environmentHome?: string | null;
}) {
  useAiLiveBridge({
    setLive,
    activeId: 0,
    activeSpaceId: "default",
    tabs: [],
    explorerRoot,
    environmentHome,
    visible,
    setActiveId: vi.fn(),
    newTab: vi.fn(),
    ensureWorkspaceReady: vi.fn().mockResolvedValue(null),
    terminalRefs: { current: new Map<number, TerminalPaneHandle>() },
  });
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.workspaceKind = "local";
  document.body.replaceChildren();
});

describe("AI live draft workspace", () => {
  it("已有 Explorer 根时也发布默认目录，供草稿排除无效重置", async () => {
    mocks.prepareDefaultWorkspaceRoot.mockResolvedValue("/default/workspace");
    const setLive = vi.fn<(live: Live) => void>();
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () =>
        root.render(
          <Harness
            explorerRoot="/default/workspace"
            visible
            setLive={setLive}
          />,
        ),
      );
      expect(setLive.mock.lastCall?.[0]).toMatchObject({
        draftCwd: "/default/workspace",
        draftProjectRoot: "/default/workspace",
        defaultDraftCwd: "/default/workspace",
      });
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("prepares a default root only when visible and lets Explorer override it", async () => {
    mocks.prepareDefaultWorkspaceRoot.mockResolvedValue(
      "/home/alice/.terax/workspace",
    );
    const setLive = vi.fn<(live: Live) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <Harness explorerRoot={null} visible={false} setLive={setLive} />,
      );
    });
    expect(mocks.prepareDefaultWorkspaceRoot).not.toHaveBeenCalled();
    expect(setLive.mock.lastCall?.[0].draftCwd).toBeNull();

    await act(async () => {
      root.render(
        <Harness explorerRoot={null} visible={true} setLive={setLive} />,
      );
      await Promise.resolve();
    });
    expect(mocks.prepareDefaultWorkspaceRoot).toHaveBeenCalledOnce();
    expect(setLive.mock.lastCall?.[0].draftCwd).toBe(
      "/home/alice/.terax/workspace",
    );

    await act(async () => {
      root.render(
        <Harness explorerRoot="/project" visible setLive={setLive} />,
      );
    });
    expect(setLive.mock.lastCall?.[0].draftCwd).toBe("/project");

    await act(async () => root.unmount());
  });

  it("waits for an SSH connection before preparing its default root", async () => {
    mocks.workspaceKind = "ssh";
    mocks.prepareDefaultWorkspaceRoot.mockResolvedValue("/srv/project");
    const setLive = vi.fn<(live: Live) => void>();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Harness explorerRoot={null} visible setLive={setLive} />);
    });
    expect(mocks.prepareDefaultWorkspaceRoot).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        <Harness
          explorerRoot={null}
          visible
          setLive={setLive}
          environmentHome="/srv/project"
        />,
      );
      await Promise.resolve();
    });
    expect(mocks.prepareDefaultWorkspaceRoot).toHaveBeenCalledOnce();
    expect(setLive.mock.lastCall?.[0].draftCwd).toBe("/srv/project");

    await act(async () => root.unmount());
  });
});
