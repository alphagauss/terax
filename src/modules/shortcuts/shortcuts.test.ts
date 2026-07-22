/**
 * 本文件验证全局快捷键注册表中目录选择动作的默认绑定。
 * 锁定 Cmd/Ctrl+O 仍由环境层决定是否执行，注册表只提供统一的默认按键。
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
