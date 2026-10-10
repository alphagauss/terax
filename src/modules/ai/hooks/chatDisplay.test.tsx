// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { ChatDisplayContext, useChatDisplayStore } from "./chatDisplay";

it("隐藏期间断开展示订阅并保持快照，恢复直接读取最新状态", async () => {
  const store = createStore(() => ({ text: "first" }));
  let listeners = 0;
  const subscribe = store.subscribe;
  store.subscribe = (listener) => {
    listeners++;
    const unsubscribe = subscribe(listener);
    return () => {
      listeners--;
      unsubscribe();
    };
  };
  function View() {
    const text = useChatDisplayStore(store, (state) => state.text);
    return <div>{text}</div>;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (active: boolean) =>
    act(async () =>
      root.render(
        <ChatDisplayContext value={active}>
          <View />
        </ChatDisplayContext>,
      ),
    );
  try {
    await render(true);
    expect(listeners).toBe(1);
    await render(false);
    expect(listeners).toBe(0);
    await act(async () => store.setState({ text: "latest" }));
    await render(false);
    expect(container.textContent).toBe("first");
    await render(true);
    expect(container.textContent).toBe("latest");
    expect(listeners).toBe(1);
  } finally {
    await act(async () => root.unmount());
  }
  expect(listeners).toBe(0);
});
