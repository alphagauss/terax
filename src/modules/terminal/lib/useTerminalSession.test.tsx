// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

const remote = vi.hoisted(() => ({
  enabled: false,
  phase: "disconnected",
  epoch: 1,
}));

vi.mock("@/lib/fonts", () => ({ ensureMonoFontsLoaded: vi.fn() }));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () =>
    remote.enabled ? { kind: "ssh", profileId: "test" } : { kind: "local" },
}));
vi.mock("@/modules/remote", () => ({
  useRemoteRuntimeStore: Object.assign(
    () =>
      remote.enabled
        ? remote.phase === "connected"
          ? remote.epoch
          : remote.phase
        : "local",
    {
      getState: () => ({
        snapshot: {
          phase: remote.phase,
          epoch: remote.epoch,
          profileId: "test",
        },
      }),
    },
  ),
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: Object.assign(() => undefined, { getState: () => ({}) }),
}));
vi.mock("./pty-bridge", () => ({ openPty: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("./agentActivity", () => ({
  ensureAgentActivityListener: vi.fn(),
  isAgentActivePty: () => false,
}));
vi.mock("./rendererPool");

import { buildTerminalTools } from "@/modules/ai/tools/terminal";
import i18n from "@/i18n";
import { openPty } from "./pty-bridge";
import {
  configureRendererPool,
  getLiveSlotForTerminal,
  type Slot,
} from "./rendererPool";
import {
  disposeSession,
  reclaimIdleRemoteTerminal,
  useTerminalSession,
} from "./useTerminalSession";

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve() },
  });
});

it("资源回收跳过前台和忙碌终端，旧 epoch 不生效，显示时才重建 Shell", async () => {
  remote.enabled = true;
  remote.phase = "connected";
  const close = vi.fn(async () => {});
  let idle = false;
  vi.mocked(openPty).mockClear();
  vi.mocked(openPty).mockResolvedValue({
    close,
    isKnownIdle: () => idle,
    resize: vi.fn(),
  } as never);
  const container = { current: document.createElement("div") };
  function Harness({ visible }: { visible: boolean }) {
    useTerminalSession({ terminalId: 81, container, visible });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness visible={true} />));
    idle = true;
    expect(reclaimIdleRemoteTerminal(remote.epoch)).toBe(false);
    await act(async () => root.render(<Harness visible={false} />));
    idle = false;
    expect(reclaimIdleRemoteTerminal(remote.epoch)).toBe(false);
    idle = true;
    expect(reclaimIdleRemoteTerminal(remote.epoch - 1)).toBe(false);
    expect(reclaimIdleRemoteTerminal(remote.epoch)).toBe(true);
    expect(close).toHaveBeenCalledWith(true);
    expect(reclaimIdleRemoteTerminal(remote.epoch)).toBe(false);
    const opened = vi.mocked(openPty).mock.calls.length;
    await act(async () => root.render(<Harness visible={false} />));
    expect(openPty).toHaveBeenCalledTimes(opened);
    remote.phase = "disconnected";
    await act(async () => root.render(<Harness visible={true} />));
    expect(openPty).toHaveBeenCalledTimes(opened);
    remote.phase = "connected";
    remote.epoch += 1;
    await act(async () => root.render(<Harness visible={true} />));
    expect(openPty).toHaveBeenCalledTimes(opened + 1);
  } finally {
    await act(async () => root.unmount());
    disposeSession(81);
    remote.enabled = false;
  }
});

it("SSH 结果提示附带本机时间，重连过程不加时间且不重复刷屏", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 16, 4, 5, 6));
  remote.enabled = true;
  remote.phase = "disconnected";
  const output: string[] = [];
  vi.mocked(getLiveSlotForTerminal).mockReturnValue({
    term: {
      buffer: { active: { type: "normal" } },
      options: {},
      write: (bytes: string | Uint8Array) =>
        output.push(
          typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes),
        ),
    },
  } as unknown as Slot);
  vi.mocked(openPty).mockResolvedValue({ close: vi.fn() } as never);
  function Harness() {
    useTerminalSession({
      terminalId: 2,
      container: { current: null },
      visible: false,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Harness />));
    expect(output.join("")).toContain(
      `${i18n.t("common:remoteWorkspace.connectionClosed")} 04:05:06`,
    );
    remote.phase = "reconnecting";
    await act(async () => root.render(<Harness />));
    expect(output[output.length - 1]).toBe(
      `\x1b[2m${i18n.t("common:remoteWorkspace.reconnecting")}\x1b[0m\r\n`,
    );
    const count = output.length;
    await act(async () => root.render(<Harness />));
    expect(output).toHaveLength(count);
    vi.setSystemTime(new Date(2026, 9, 16, 4, 5, 9));
    remote.phase = "connected";
    await act(async () => root.render(<Harness />));
    expect(output[output.length - 1]).toContain(
      `${i18n.t("common:remoteWorkspace.connected")} 04:05:09`,
    );
    const connectedCount = output.length;
    await act(async () => root.render(<Harness />));
    expect(output).toHaveLength(connectedCount);
  } finally {
    await act(async () => root.unmount());
    disposeSession(2);
    remote.enabled = false;
    vi.mocked(getLiveSlotForTerminal).mockReset();
    vi.useRealTimers();
  }
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
