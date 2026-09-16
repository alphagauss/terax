/** 本文件验证查找输入只在组合输入完成后提交增量搜索。 */

// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FindPatternField } from "./FindPatternField";

afterEach(() => {
  document.body.replaceChildren();
});

it("does not commit an incomplete IME composition", async () => {
  const committed = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const [query, setQuery] = useState("");
    return (
      <FindPatternField
        query={query}
        onQueryChange={setQuery}
        onQueryCommit={committed}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const input = container.querySelector("input");
  expect(input).not.toBeNull();
  if (!input) return;

  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "中";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "中",
        isComposing: true,
      }),
    );
  });
  expect(committed).not.toHaveBeenCalled();

  await act(async () => {
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
  });
  expect(committed).toHaveBeenCalledOnce();
  expect(committed).toHaveBeenLastCalledWith("中");

  await act(async () => root.unmount());
});
