// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NotificationNavigationBridge } from "./NotificationNavigationBridge";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
let root: Root;
const target = { module: "terminal", tabId: 7 };
const activation = { id: "notification-1", target };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.listen.mockResolvedValue(mocks.stop);
  mocks.invoke.mockImplementation(async (command) =>
    command === "notification_get_activation" ? activation : undefined,
  );
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
});

it("订阅后读取原生目标，导航完成后再确认", async () => {
  const navigate = vi.fn();
  await act(async () => {
    root.render(<NotificationNavigationBridge onActivate={navigate} />);
  });
  expect(navigate).toHaveBeenCalledWith(target);
  expect(mocks.invoke.mock.calls).toEqual([
    ["notification_get_activation"],
    ["notification_ack_activation", { id: activation.id }],
  ]);
});

it("卸载期间返回的目标不确认，重挂载后仍可处理", async () => {
  let finish: (value: typeof activation) => void = () => {};
  mocks.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const navigate = vi.fn();
  await act(async () => {
    root.render(<NotificationNavigationBridge onActivate={navigate} />);
  });
  act(() => root.unmount());
  await act(async () => {
    finish(activation);
  });
  expect(navigate).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledOnce();
  root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(<NotificationNavigationBridge onActivate={navigate} />);
  });
  expect(navigate).toHaveBeenCalledOnce();
  expect(mocks.invoke).toHaveBeenLastCalledWith("notification_ack_activation", {
    id: activation.id,
  });
});
