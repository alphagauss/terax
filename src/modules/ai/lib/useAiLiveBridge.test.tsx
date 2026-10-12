// @vitest-environment happy-dom
/**
 * 本文件测试 Workbench 向 AI 发布草稿工作目录和实时终端输出。
 * 锁定目录延迟准备与优先级，以及终端按需读取和脱敏。
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
import { buildTerminalTools } from "../tools/terminal";
import { useAiLiveBridge } from "./useAiLiveBridge";

function Harness({
  explorerRoot,
  visible,
  setLive,
  environmentHome = null,
  tabs = [],
  terminalRefs = { current: new Map<number, TerminalPaneHandle>() },
}: {
  explorerRoot: string | null;
  visible: boolean;
  setLive: (live: Live) => void;
  environmentHome?: string | null;
  tabs?: Parameters<typeof useAiLiveBridge>[0]["tabs"];
  terminalRefs?: Parameters<typeof useAiLiveBridge>[0]["terminalRefs"];
}) {
  useAiLiveBridge({
    setLive,
    activeId: 0,
    activeSpaceId: "default",
    tabs,
    explorerRoot,
    environmentHome,
    visible,
    setActiveId: vi.fn(),
    newTab: vi.fn(),
    ensureWorkspaceReady: vi.fn().mockResolvedValue(null),
    terminalRefs,
  });
  return null;
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.workspaceKind = "local";
  document.body.replaceChildren();
});

describe("AI live draft workspace", () => {
  it.each([
    [undefined, undefined],
    [1000, undefined],
    [2000, undefined],
    [80, 80],
  ])(
    "按工具请求读取终端行数和偏移并保持脱敏：%s / %s",
    async (lines, offset) => {
      const buffer = Array.from({ length: 2000 }, (_, i) =>
        i === 1999 ? "API_KEY=secret" : `line ${i}`,
      );
      const getBuffer = vi.fn((maxLines = 200) =>
        buffer.slice(-maxLines).join("\n"),
      );
      const terminal: TerminalPaneHandle = {
        getBuffer,
        getSelection: () => null,
        open: vi.fn(),
        write: vi.fn(),
        focus: vi.fn(),
      };
      const setLive = vi.fn<(live: Live) => void>();
      const root = createRoot(document.createElement("div"));
      try {
        await act(async () =>
          root.render(
            <Harness
              explorerRoot="/workspace"
              visible={false}
              setLive={setLive}
              tabs={[
                {
                  id: 0,
                  spaceId: "default",
                  title: "terminal",
                  kind: "terminal",
                },
              ]}
              terminalRefs={{
                current: new Map([[0, terminal]]),
              }}
            />,
          ),
        );
        const live = setLive.mock.lastCall?.[0];
        if (!live) throw new Error("missing live context");
        const tool = buildTerminalTools({
          ...live,
          getCwd: () => "/workspace",
          getSessionId: () => "session",
          getPermissionMode: () => "ask",
          supportsApprovals: true,
        }).get_terminal_output;
        const result = await tool.execute?.(
          { lines, offset },
          { toolCallId: "call", messages: [], context: undefined as never },
        );
        const requested = lines ?? 80;
        const skipped = offset ?? 0;
        expect(getBuffer).toHaveBeenCalledWith(requested + skipped);
        const end = buffer.length - skipped;
        expect(result).toEqual({
          output: buffer
            .slice(end - requested, end)
            .map((line) => line.replace("API_KEY=secret", "API_KEY=<REDACTED>"))
            .join("\n"),
          lines_returned: requested,
          truncated: false,
        });
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

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
