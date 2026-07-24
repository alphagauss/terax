/**
 * 本文件验证编辑器字号与应用缩放的合成规则及 CodeMirror 重测不变量。
 *
 * 设置变化必须通过配置事务更新视图，并显式请求重新测量虚拟化几何。
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

  it("reconfigures CodeMirror and explicitly requests a new measurement", () => {
    const dispatch = vi.fn();
    const requestMeasure = vi.fn();
    const view = {
      dispatch,
      requestMeasure,
      documentTop: -100,
      scaleY: 1,
      scrollDOM: {
        getBoundingClientRect: () => ({ top: 0 }),
      },
      lineBlockAtHeight: vi.fn(() => ({ from: 42 })),
    } as unknown as EditorView;

    reconfigureEditorFontMetrics(view, 16, 1.25);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0]).toHaveProperty("effects");
    expect(view.lineBlockAtHeight).toHaveBeenCalledWith(100);
    expect(requestMeasure).toHaveBeenCalledOnce();
  });
});
