/**
 * 本文件验证 Channels 设置页的实例草稿、显式保存和选择平台后添加的流程。
 * 仅替换主窗口与存储边界，锁定切换或异步快照不丢输入、部分保存失败可重试。
 */

// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChannelsView, type ChannelAction } from "@/modules/channels/client";
import { ChannelsSection } from "@/modules/channels/components/ChannelsSection";
import type { ChannelSnapshot } from "@/modules/channels/types";

const io = vi.hoisted(() => ({
  request: vi.fn(),
  route: vi.fn(),
  login: vi.fn(),
  network: { values: {} as Record<string, unknown>, ready: true, error: false },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async () => ({ isPrimary: true, env: { kind: "local" } }),
}));
vi.mock("@/modules/workspace-process", () => ({
  spawnWorkspaceProcess: vi.fn(),
}));
vi.mock("@/modules/channels/client", async (original) => ({
  ...(await original<typeof import("@/modules/channels/client")>()),
  requestChannels: io.request,
  subscribeChannelsView: async () => () => {},
}));
vi.mock("@/modules/network/settings", () => ({
  setNetworkRoute: io.route,
  useNetworkSettings: () => io.network,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, args?: { number?: number }) =>
      key === "defaultName" ? `WeChat ${args?.number}` : key,
  }),
}));
const snapshot = (id: string, name: string): ChannelSnapshot => ({
  connection: {
    id,
    name,
    kind: "weixin",
    sessionId: `session-${id}`,
    enabled: false,
    accountId: null,
    busyMessageMode: "steer",
  },
  status: "disabled",
  issue: null,
  busy: false,
  queued: 0,
});
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  io.login.mockReset().mockResolvedValue(undefined);
  io.network.values = {};
  io.network.error = false;
  io.route
    .mockReset()
    .mockImplementation(async (key: string, route: string) => {
      io.network.values[key] = route;
    });
  io.request.mockReset().mockImplementation(async (action: ChannelAction) => {
    if (action.action === "login") await io.login();
    const current = useChannelsView.getState().snapshots;
    if (action.action === "update")
      useChannelsView.setState({
        snapshots: current.map((item) =>
          item.connection.id === action.id
            ? {
                ...item,
                connection: {
                  ...item.connection,
                  name: action.name.trim(),
                  busyMessageMode: action.mode,
                },
              }
            : item,
        ),
      });
    if (action.action === "add")
      useChannelsView.setState({
        snapshots: [...current, snapshot("new", action.name)],
      });
    return useChannelsView.getState();
  });
  useChannelsView.setState({
    snapshots: [snapshot("a", "Alpha"), snapshot("b", "Beta")],
    error: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ChannelsSection />);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = false;
});

function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}

function nameInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    'input[aria-label="namePlaceholder"]',
  );
  if (!input) throw new Error("Missing name input");
  return input;
}

async function enterName(value: string) {
  await act(async () => {
    const input = nameInput();
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("切换实例和接收运行快照保留草稿及输入焦点，保存只修改当前实例", async () => {
  await enterName("Draft Alpha");
  const input = nameInput();
  input.focus();
  await act(async () =>
    useChannelsView.setState({
      snapshots: useChannelsView
        .getState()
        .snapshots.map((item) => ({ ...item, queued: 2 })),
    }),
  );
  expect(nameInput()).toBe(input);
  expect(document.activeElement).toBe(input);
  await act(async () => button("Beta").click());
  await enterName("Draft Beta");
  await act(async () => button("Alpha").click());
  expect(nameInput().value).toBe("Draft Alpha");
  expect(io.request).not.toHaveBeenCalled();
  await act(async () => button("save").click());
  expect(io.request).toHaveBeenCalledWith({
    action: "update",
    id: "a",
    name: "Draft Alpha",
    mode: "steer",
  });
  await act(async () => button("Beta").click());
  expect(nameInput().value).toBe("Draft Beta");
});

it("路由保存失败保留草稿和部分成功结果，重试只写未保存路由", async () => {
  await enterName("Renamed");
  await act(async () => {
    container
      .querySelector('[aria-label="settings:network.route"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
  });
  await act(async () => {
    const option = [
      ...document.querySelectorAll<HTMLElement>('[role="option"]'),
    ].find((item) => item.textContent?.includes("settings:network.shared"));
    expect(option).toBeDefined();
    option?.click();
  });
  io.route.mockImplementationOnce(async () => {
    io.network.error = true;
    throw new Error("disk failed");
  });
  await act(async () => button("save").click());
  expect(container.textContent).toContain("errors.route-save");
  expect(nameInput().value).toBe("Renamed");
  expect(useChannelsView.getState().snapshots[0].connection.name).toBe(
    "Renamed",
  );
  expect(button("save").disabled).toBe(false);
  await act(async () => button("Beta").click());
  expect(container.textContent).not.toContain("errors.route-save");
  await act(async () => button("Renamed").click());
  expect(
    container.querySelector('[aria-label="settings:network.route"]')
      ?.textContent,
  ).toContain("settings:network.shared");
  await act(async () => button("save").click());
  expect(io.request).toHaveBeenCalledTimes(1);
  expect(io.route).toHaveBeenCalledTimes(2);
  expect(button("save").disabled).toBe(true);
});

it("打开平台菜单不创建实例，选择平台后自动命名并授权，失败仍可重试", async () => {
  io.login.mockRejectedValueOnce(new Error("network"));
  await act(async () =>
    button("add").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    ),
  );
  expect(io.request).not.toHaveBeenCalled();
  const platform = document.querySelector<HTMLElement>('[role="menuitem"]');
  expect(platform?.textContent).toBe("weixin");
  await act(async () => platform?.click());
  expect(io.request.mock.calls.map(([action]) => action)).toEqual([
    { action: "add", kind: "weixin", name: "WeChat 1" },
    { action: "login", id: "new" },
  ]);
  expect(nameInput().value).toBe("WeChat 1");
  expect(container.textContent).toContain("errors.network");
  expect(button("login").disabled).toBe(false);
});
