/** 验证通知面板中的 Channel 快捷操作不会改变原有的会话打开入口。 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChannelsView } from "@/modules/channels/client";
import { ChannelStatusRows } from "@/modules/channels/components/ChannelStatusRows";
import type { ChannelSnapshot } from "@/modules/channels/types";

const io = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/modules/channels/client", async (original) => ({
  ...(await original<typeof import("@/modules/channels/client")>()),
  requestChannels: io.request,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const snapshot = (
  id: string,
  enabled: boolean,
  accountId: string | null = "owner",
): ChannelSnapshot => ({
  connection: {
    id,
    name: "WeChat",
    kind: "weixin",

    enabled,
    accountId,
    busyMessageMode: "steer",
  },
  status: enabled ? "online" : "disabled",
  issue: null,
  busy: false,
  queued: 0,
  conversations: [],
});

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  io.request.mockReset().mockResolvedValue({});
  useChannelsView.setState({
    snapshots: [snapshot("enabled", true), snapshot("disabled", false)],
    error: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("断开按钮复用连接设置的 enable 操作且不打开会话", async () => {
  const onActivate = vi.fn();
  await act(async () =>
    root.render(<ChannelStatusRows onActivate={onActivate} />),
  );
  const disconnect = container.querySelector<HTMLButtonElement>(
    '[aria-label="disconnect"]',
  );
  await act(async () => disconnect?.click());
  expect(io.request).toHaveBeenCalledWith({
    action: "enable",
    id: "enabled",
    enabled: false,
  });
  expect(onActivate).not.toHaveBeenCalled();
});

it("未启用的已登录连接显示连接按钮，未登录连接不可操作", async () => {
  useChannelsView.setState({
    snapshots: [snapshot("disabled", false), snapshot("login", false, null)],
  });
  await act(async () =>
    root.render(<ChannelStatusRows onActivate={vi.fn()} />),
  );
  expect(
    container.querySelector<HTMLButtonElement>('[aria-label="connect"]')
      ?.disabled,
  ).toBe(false);
  expect(
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[aria-label="connect"]',
      ),
    ].find((button) => button.disabled)?.disabled,
  ).toBe(true);
});
