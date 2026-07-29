/**
 * 本文件测试终端鼠标旁路的纯路由规则。
 * 锁定 TUI 鼠标模式、平台修饰键和滚轮单位换算的不变量。
 */

import { describe, expect, it } from "vitest";
import {
  shouldUseLocalTerminalMouse,
  terminalMouseOverrideHeld,
  terminalWheelDeltaRows,
} from "./mouseRouting";

describe("terminal mouse routing", () => {
  it("uses local behavior when mouse tracking is disabled", () => {
    expect(
      shouldUseLocalTerminalMouse(
        "none",
        { altKey: false, shiftKey: false },
        false,
      ),
    ).toBe(true);
  });

  it.each([
    "x10",
    "vt200",
    "drag",
    "any",
  ] as const)("reports %s mouse mode without Shift", (mode) => {
    expect(
      shouldUseLocalTerminalMouse(
        mode,
        { altKey: false, shiftKey: false },
        false,
      ),
    ).toBe(false);
  });

  it("uses Shift off macOS and Option on macOS", () => {
    expect(
      terminalMouseOverrideHeld({ altKey: false, shiftKey: true }, false),
    ).toBe(true);
    expect(
      terminalMouseOverrideHeld({ altKey: true, shiftKey: false }, true),
    ).toBe(true);
    expect(
      terminalMouseOverrideHeld({ altKey: false, shiftKey: true }, true),
    ).toBe(false);
  });

  it("uses local behavior when the platform override is held", () => {
    expect(
      shouldUseLocalTerminalMouse(
        "any",
        { altKey: false, shiftKey: true },
        false,
      ),
    ).toBe(true);
    expect(
      shouldUseLocalTerminalMouse(
        "drag",
        { altKey: true, shiftKey: false },
        true,
      ),
    ).toBe(true);
  });
});

describe("terminalWheelDeltaRows", () => {
  it("normalizes pixel, line, and page deltas", () => {
    expect(terminalWheelDeltaRows(24, 0, 12, 30)).toBe(2);
    expect(terminalWheelDeltaRows(-3, 1, 12, 30)).toBe(-3);
    expect(terminalWheelDeltaRows(1, 2, 12, 30)).toBe(30);
  });

  it("guards against an unavailable cell height", () => {
    expect(terminalWheelDeltaRows(3, 0, 0, 30)).toBe(3);
  });
});
