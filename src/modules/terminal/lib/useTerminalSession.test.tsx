// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("@/modules/remote", () => ({
  useRemoteRuntimeStore: Object.assign(() => "local", {
    getState: () => ({ snapshot: { phase: "idle" } }),
  }),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: () => undefined,
}));
vi.mock("./agentActivity", () => ({
  ensureAgentActivityListener: vi.fn(),
  isAgentActivePty: () => false,
}));
vi.mock("./rendererPool");

import { buildTerminalTools } from "@/modules/ai/tools/terminal";
import {
  configureRendererPool,
  getLiveSlotForTerminal,
  type Slot,
} from "./rendererPool";
import { disposeSession, useTerminalSession } from "./useTerminalSession";

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

describe("终端输出分页", () => {
  it.each(["live", "snapshot"])(
    "%s 先排除末尾空行，连续两页不漏掉历史行",
    async (source) => {
      const lines = Array.from({ length: 160 }, (_, i) => `line ${i + 1}`);
      const buffer = [...lines, "", "", ""];
      let session!: ReturnType<typeof useTerminalSession>;
      function Harness() {
        session = useTerminalSession({
          terminalId: 1,
          container: { current: null },
          visible: false,
        });
        return null;
      }
      const root = createRoot(document.createElement("div"));
      try {
        await act(async () => root.render(<Harness />));
        if (source === "live") {
          vi.mocked(getLiveSlotForTerminal).mockReturnValue({
            term: {
              buffer: {
                active: {
                  length: buffer.length,
                  getLine: (i: number) => ({
                    translateToString: () => buffer[i],
                  }),
                },
              },
            },
          } as unknown as Slot);
        } else {
          vi.mocked(getLiveSlotForTerminal).mockReturnValue(null);
          vi.mocked(configureRendererPool).mock.calls[0][0].storeSnapshot(1, {
            snapshot: `\x1b[31m${buffer.join("\n")}\x1b[0m`,
            cols: 80,
            rows: 24,
            altScreen: false,
          });
        }
        const tool = buildTerminalTools({
          getCwd: () => "/workspace",
          getSessionId: () => "session",
          getPermissionMode: () => "ask",
          supportsApprovals: true,
          isActiveTerminalPrivate: () => false,
          getTerminalContext: session.getBuffer,
        }).get_terminal_output;
        for (const offset of [0, 80]) {
          const output = await tool.execute?.(
            { lines: 80, offset },
            { toolCallId: "call", messages: [], context: undefined as never },
          );
          expect(output).toEqual({
            output: lines.slice(80 - offset, 160 - offset).join("\n"),
            lines_returned: 80,
            truncated: false,
          });
        }
      } finally {
        await act(async () => root.unmount());
        disposeSession(1);
        vi.mocked(getLiveSlotForTerminal).mockReset();
      }
    },
  );
});
