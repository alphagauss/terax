import "katex/dist/katex.min.css";

import { createMathPlugin } from "@streamdown/math";

export const streamdownPlugins = {
  math: createMathPlugin({ singleDollarTextMath: true }),
};
