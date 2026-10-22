import "katex/dist/katex.min.css";

import { createMathPlugin } from "@streamdown/math";
import remarkBreaks from "remark-breaks";
import { defaultRemarkPlugins } from "streamdown";

// 段内回车生成紧凑换行，空行仍由 Markdown 解析为独立段落。
export const streamdownRemarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkBreaks,
];

export const streamdownPlugins = {
  // 普通美元符号不参与公式配对，行内公式统一使用双美元。
  math: createMathPlugin({ singleDollarTextMath: false }),
};
