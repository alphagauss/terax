/**
 * 本文件测试 xterm OSC 8 链接与系统 opener 的桥接。
 * 重点锁定原生打开完成后使用最新绑定的终端焦点回调。
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { createTerminalLinkHandler } from "./terminalLinks";

describe("createTerminalLinkHandler", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("opens OSC 8 links natively and restores late-bound focus", async () => {
    openUrl.mockResolvedValue(undefined);
    const initialFocus = vi.fn();
    let focus = initialFocus;
    const handler = createTerminalLinkHandler(() => focus());
    focus = vi.fn();

    handler.activate({} as MouseEvent, "https://example.com/usage");

    expect(openUrl).toHaveBeenCalledWith("https://example.com/usage");
    await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
    expect(initialFocus).not.toHaveBeenCalled();
  });
});
