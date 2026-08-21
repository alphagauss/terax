/**
 * 本文件测试命令式快捷键标签解析。
 * 锁定用户覆盖优先于默认绑定，并保持非 React 调用方的格式一致。
 */

import { MOD_PROP } from "@/lib/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KeyBinding } from "../shortcuts";

const prefsMock = vi.hoisted(() => ({
  shortcuts: {} as Record<string, KeyBinding[]>,
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ shortcuts: prefsMock.shortcuts }),
  },
}));

import { shortcutLabel } from "./shortcutLabel";

beforeEach(() => {
  prefsMock.shortcuts = {};
});

describe("shortcutLabel", () => {
  it("没有用户覆盖时格式化默认绑定", () => {
    expect(shortcutLabel("commandPalette.open")).toContain("P");
  });

  it("优先使用用户覆盖", () => {
    prefsMock.shortcuts = {
      "commandPalette.open": [{ [MOD_PROP]: true, shift: true, key: "k" }],
    };
    expect(shortcutLabel("commandPalette.open")).toContain("K");
    expect(shortcutLabel("commandPalette.open")).not.toContain("P");
  });
});
