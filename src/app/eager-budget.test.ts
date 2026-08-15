/**
 * 本文件锁定主窗口和辅助窗口公共入口的 eager bundle 边界。
 * 编辑器、AI 和 Markdown 等重型功能只能由具体页面按需加载。
 */

import { describe, expect, it } from "vitest";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Locks the startup-bundle invariant: the heavy editor / AI / markdown stacks
// must stay out of the eager graph of both window entries so they load only
// when the user opens those surfaces. A static import that re-introduces any of
// these (e.g. a barrel re-export of chat runtime, or a `cn`-style util getting
// absorbed into a feature chunk) will fail here. xterm and motion are
// intentionally eager (terminal-first shell) and are not asserted against.
const HEAVY = [
  "@ai-sdk",
  "ai",
  "streamdown",
  "@streamdown",
  "mermaid",
  "@codemirror",
  "@uiw",
];

function heavyEagerHits(entry: string): string[] {
  const { hits } = traceEager(entry, HEAVY);
  return [...hits.entries()].map(([pkg, info]) => `${pkg} <- ${info.file}`);
}

describe("startup bundle budget", () => {
  it("main window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/main.tsx")).toEqual([]);
  });

  it("auxiliary window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/auxiliary/main.tsx")).toEqual([]);
  });
});
