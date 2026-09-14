import "katex/dist/katex.min.css";

import { createMathPlugin } from "@streamdown/math";

export const streamdownPlugins = {
  // 普通美元符号不参与公式配对，行内公式统一使用双美元。
  math: createMathPlugin({ singleDollarTextMath: false }),
};
