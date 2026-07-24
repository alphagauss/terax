/**
 * 本文件验证全局快捷键注册表中的默认绑定。
 * 锁定设置页展示与各模块实际处理快捷键时共用同一份注册表定义。
 */

import { MOD_PROP } from "@/lib/platform";
import { describe, expect, it } from "vitest";
import { SHORTCUTS } from "./shortcuts";

describe("folder picker shortcut", () => {
  it("registers Cmd/Ctrl+O as the default binding", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "folder.open",
      label: "Open folder",
      group: "General",
      defaultBindings: [{ [MOD_PROP]: true, key: "o" }],
    });
  });
});

describe("temporary word wrap shortcut", () => {
  it("registers Alt+Z as the default editor binding", () => {
    expect(SHORTCUTS).toContainEqual({
      id: "editor.toggleWordWrap",
      label: "Toggle word wrap",
      group: "Editor",
      defaultBindings: [{ alt: true, key: "z" }],
    });
  });
});
