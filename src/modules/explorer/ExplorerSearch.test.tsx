// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { ViewStateScope } from "@/modules/view-state";
import { resetViewCachesForTests } from "@/modules/view-state/cache";
import { ExplorerSearch } from "./ExplorerSearch";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("./lib/iconResolver", () => ({ fileIconUrl: () => "" }));

it("恢复文件名搜索时不重新查询或定位选中行，键盘导航仍定位新选中项", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  resetViewCachesForTests();
  vi.mocked(invoke).mockResolvedValue({
    hits: ["a", "b"].map((name) => ({
      name,
      rel: name,
      path: `/repo/${name}`,
      is_dir: false,
    })),
    truncated: false,
  });
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (space: string) =>
    act(async () =>
      root.render(
        <ViewStateScope kind="sidebar" scope={space} view="explorer" visible>
          <ExplorerSearch
            rootPath="/repo"
            open
            onOpenFile={() => {}}
            onRequestClose={() => {}}
          />
        </ViewStateScope>,
      ),
    );
  try {
    await render("a");
    const input = container.querySelector("input");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!input || !setter) throw new Error("缺少搜索输入框");
    await act(async () => {
      setter.call(input, "needle");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(invoke).toHaveBeenCalledTimes(1);
    await render("b");
    scrollIntoView.mockClear();
    await render("a");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("needle");
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      ),
    );
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('[data-index="1"]'),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
