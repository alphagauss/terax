// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn(async () => []),
  release: vi.fn(),
  disconnect: vi.fn(),
  connection: null as ((connected: boolean) => void) | null,
  taskEvent: null as (() => void) | null,
}));
vi.mock("@/modules/alpha/api", () => ({ getAlphaTasks: mocks.getTasks }));
vi.mock("@/modules/alpha/events/tasks", () => ({
  subscribeAlphaTasks: (callback: () => void) => {
    mocks.taskEvent = callback;
    return mocks.release;
  },
  subscribeAlphaEventConnection: (callback: (connected: boolean) => void) => {
    mocks.connection = callback;
    return mocks.disconnect;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
import { TaskMonitorScene } from "@/modules/alpha/scenes/TaskMonitorScene";

it("隐藏时不查询或订阅，显示和重连读取快照，收起只释放观察", async () => {
  const root = createRoot(document.createElement("div"));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const render = (visible: boolean) =>
    root.render(
      <QueryClientProvider client={client}>
        <TaskMonitorScene visible={visible} />
      </QueryClientProvider>,
    );
  try {
    await act(async () => render(false));
    expect(mocks.getTasks).not.toHaveBeenCalled();
    expect(mocks.connection).toBeNull();
    await act(async () => render(true));
    expect(mocks.getTasks).toHaveBeenCalledTimes(1);
    await act(async () => mocks.connection?.(true));
    expect(mocks.getTasks).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (let i = 0; i < 20; i++) mocks.taskEvent?.();
      await new Promise((resolve) => setTimeout(resolve, 275));
    });
    expect(mocks.getTasks).toHaveBeenCalledTimes(3);
    mocks.taskEvent?.();
    await act(async () => render(false));
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    await client.invalidateQueries({ queryKey: ["alpha", "tasks"] });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 275));
    });
    expect(mocks.getTasks).toHaveBeenCalledTimes(3);
    await act(async () => render(true));
    expect(mocks.getTasks).toHaveBeenCalledTimes(4);
  } finally {
    act(() => root.unmount());
    client.clear();
  }
});
