/**
 * 本文件测试标签切换浮层的顺序计算。
 * 重点锁定当前标签位于列表中间时仍按可见顺序循环。
 */

import { describe, expect, it } from "vitest";
import { advanceTabSwitcher } from "./useTabSwitcher";

describe("tab switcher order", () => {
  it("starts after the active tab without rotating the displayed order", () => {
    expect(advanceTabSwitcher(null, 1, [10, 20, 30], 20)).toEqual({
      order: [10, 20, 30],
      index: 2,
      initialId: 20,
    });
  });

  it("wraps backwards from the first visible tab", () => {
    expect(advanceTabSwitcher(null, -1, [10, 20, 30], 10)).toEqual({
      order: [10, 20, 30],
      index: 2,
      initialId: 10,
    });
  });
});
