/**
 * 本文件验证设置存储的归一化与默认值不变量。
 * 锁定字体字重兼容逻辑，以及首次启动时的语言、终端和 SSH 文件默认值。
 */

import { describe, expect, it } from "vitest";
import { coerceFontWeight, DEFAULT_PREFERENCES } from "./store";

describe("coerceFontWeight", () => {
  it("keeps supported weights", () => {
    for (const w of ["normal", "500", "600", "bold"]) {
      expect(coerceFontWeight(w)).toBe(w);
    }
  });

  it("trims surrounding whitespace", () => {
    expect(coerceFontWeight("  bold  ")).toBe("bold");
  });

  it("falls back to normal for unsupported or empty values", () => {
    expect(coerceFontWeight("")).toBe("normal");
    expect(coerceFontWeight("900")).toBe("normal");
    expect(coerceFontWeight("heavy")).toBe("normal");
  });
});

describe("DEFAULT_PREFERENCES", () => {
  it("defaults new installations to Simplified Chinese", () => {
    expect(DEFAULT_PREFERENCES.language).toBe("zh-CN");
  });

  it("enables smart terminal copy and paste by default", () => {
    expect(DEFAULT_PREFERENCES.terminalSmartCopyPaste).toBe(true);
  });

  it("enables automatic SSH file acceleration by default", () => {
    expect(DEFAULT_PREFERENCES.sshFileAcceleration).toBe(true);
  });
});
