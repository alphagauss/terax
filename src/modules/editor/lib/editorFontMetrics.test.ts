/**
 * 本文件验证编辑器字号与应用缩放的合成规则及 CodeMirror 重测不变量。
 *
 * 设置变化必须通过单一配置事务更新视图，不得依赖尚未稳定的 DOM 布局或主动滚动。
 */

import type { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  effectiveEditorFontSize,
  reconfigureEditorFontMetrics,
} from "./extensions";

describe("editor font metrics", () => {
  it("combines the independent editor font size with application zoom", () => {
    expect(effectiveEditorFontSize(13, 1)).toBe(13);
    expect(effectiveEditorFontSize(13, 1.5)).toBe(19.5);
    expect(effectiveEditorFontSize(20, 0.8)).toBe(16);
  });

  it("reconfigures without layout reads and requests a new measurement", () => {
    const dispatch = vi.fn();
    const requestMeasure = vi.fn();
    const view = {
      dispatch,
      requestMeasure,
    } as unknown as EditorView;

    reconfigureEditorFontMetrics(view, 16, 1.25);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toHaveProperty("effects");
    expect(requestMeasure).toHaveBeenCalledOnce();
  });
});
