/**
 * 本文件测试 Git 历史图轨道宽度的计算边界。
 * 锁定最小宽度、随轨道增长及可见轨道上限钳制。
 */

import { describe, expect, it } from "vitest";
import { MAX_VISIBLE_LANES, railWidth } from "./GraphRail";

describe("railWidth", () => {
  it("零条和一条轨道使用相同最小宽度", () => {
    expect(railWidth(0)).toBe(railWidth(1));
  });

  it("轨道增加时宽度递增", () => {
    expect(railWidth(2)).toBeGreaterThan(railWidth(1));
    expect(railWidth(3)).toBeGreaterThan(railWidth(2));
  });

  it("达到可见轨道上限后钳制宽度", () => {
    const capped = railWidth(MAX_VISIBLE_LANES);
    expect(railWidth(MAX_VISIBLE_LANES + 1)).toBe(capped);
    expect(railWidth(100)).toBe(capped);
  });
});
