/**
 * 本文件测试所有内置主题都在自身 variant 内完整描述编辑器调色板。
 * 禁止重新引入主题 ID 配对或集中式内置编辑器颜色表。
 */

import { describe, expect, it } from "vitest";
import { EDITOR_PALETTE_REQUIRED_KEYS } from "../themeRegistry";
import { listBuiltinThemes } from ".";

describe("builtin embedded editor themes", () => {
  for (const theme of listBuiltinThemes()) {
    for (const [mode, variant] of Object.entries(theme.variants)) {
      it(`${theme.id} ${mode} embeds every required editor color`, () => {
        expect(variant?.editor).toBeDefined();
        for (const key of EDITOR_PALETTE_REQUIRED_KEYS) {
          expect(variant?.editor[key]).toBeTruthy();
        }
      });
    }
  }
});
