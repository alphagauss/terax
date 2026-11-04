// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ViewStateScope,
  useViewActive,
  useViewState,
  pruneViewStates,
} from "./ViewState";
import { resetViewCachesForTests } from "./cache";
import { useViewCommand } from "./useViewCommand";
import { useViewScroll } from "./useViewScroll";

const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetViewCachesForTests();
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("按 Space 隔离状态，隐藏或窗口不可见时暂停，关闭后丢弃视图缓存", async () => {
  let change!: (value: string) => void;
  let initial = "initial";
  function View() {
    const [text, setText] = useViewState("text", initial);
    change = setText;
    return (
      <span>
        {text}:{String(useViewActive())}
      </span>
    );
  }
  const render = async (scope: string, visible = true) =>
    act(async () =>
      root.render(
        <ViewStateScope
          kind="sidebar"
          scope={scope}
          view="tree"
          visible={visible}
        >
          <View />
        </ViewStateScope>,
      ),
    );
  await render("a");
  await act(async () => change("A"));
  await render("b");
  expect(container.textContent).toBe("initial:true");
  initial = "new default";
  await render("a", false);
  expect(container.textContent).toBe("A:false");
  await render("a");
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("hidden");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.textContent).toBe("A:false");
  visibility.mockReturnValue("visible");
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(container.textContent).toBe("A:true");
  await render("b");
  expect(container.textContent).toBe("initial:true");
  pruneViewStates(new Set(["b"]), new Set());
  await render("a");
  expect(container.textContent).toBe("new default:true");
});

it("用户命令恢复时不重放，修改输入或显式重新执行才读取", async () => {
  const run = vi.fn();
  const cancel = vi.fn();
  let change!: (value: string) => void;
  let repeat!: () => void;
  function View() {
    const active = useViewActive();
    const [input, setInput] = useViewState("input", "");
    const [version, setVersion] = useViewState("version", 0);
    change = setInput;
    repeat = () => setVersion((value) => value + 1);
    useViewCommand("command", `${input}:${version}`, active, () => {
      if (!input) return;
      run(input);
      return cancel;
    });
    return <span>{input}</span>;
  }
  const render = async (scope: string, visible = true) =>
    act(async () =>
      root.render(
        <ViewStateScope
          kind="sidebar"
          scope={scope}
          view="query"
          visible={visible}
        >
          <View />
        </ViewStateScope>,
      ),
    );
  await render("a");
  await act(async () => change("needle"));
  expect(run).toHaveBeenCalledTimes(1);
  await render("a", false);
  expect(cancel).toHaveBeenCalledTimes(1);
  await render("a");
  await render("b");
  await render("a");
  expect(container.textContent).toBe("needle");
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => repeat());
  expect(run).toHaveBeenCalledTimes(2);
  await act(async () => change("next"));
  expect(run).toHaveBeenLastCalledWith("next");
});

it("按稳定行恢复阅读位置，前插数据、切换 Space 和重挂均保留锚点", async () => {
  function View({ keys, present }: { keys: string[]; present: boolean }) {
    const element = useRef<HTMLDivElement>(null);
    const attach = useViewScroll("list", element, keys, useViewActive(), 24);
    if (!present) return null;
    return (
      <div ref={attach} data-scroll>
        {keys.join(",")}
      </div>
    );
  }
  const initialKeys = ["a", "b", "c"];
  const render = async (scope: string, keys = initialKeys, present = true) =>
    act(async () =>
      root.render(
        <ViewStateScope kind="sidebar" scope={scope} view="list" visible>
          <View keys={keys} present={present} />
        </ViewStateScope>,
      ),
    );
  await render("a");
  const element = container.querySelector<HTMLElement>("[data-scroll]");
  if (!element) throw new Error("缺少列表");
  element.scrollTop = 29;
  element.dispatchEvent(new Event("scroll"));
  await render("a", ["new", "a", "b", "c"]);
  expect(element.scrollTop).toBe(53);
  await render("b");
  expect(element.scrollTop).toBe(0);
  await render("a");
  expect(element.scrollTop).toBe(29);
  await render("a", initialKeys, false);
  await render("a");
  expect(container.querySelector<HTMLElement>("[data-scroll]")?.scrollTop).toBe(
    29,
  );
  await act(async () => root.render(null));
  await render("a");
  expect(container.querySelector<HTMLElement>("[data-scroll]")?.scrollTop).toBe(
    29,
  );
  const restored = container.querySelector<HTMLElement>("[data-scroll]");
  if (!restored) throw new Error("缺少恢复后的列表");
  restored.scrollTop = 0;
  restored.dispatchEvent(new Event("scroll"));
  await render("a", ["new", "a", "b", "c"]);
  expect(restored.scrollTop).toBe(0);
});
