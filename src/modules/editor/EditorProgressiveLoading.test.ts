/**
 * 本文件锁定代码编辑器的渐进加载边界。
 *
 * 文件读取必须与 CodeMirror 运行时并行，Vim 和语言包不得重新进入基础编辑器分块。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editorDir = import.meta.dirname;
const lazyView = readFileSync(
  path.join(editorDir, "EditorViewLazy.tsx"),
  "utf8",
);
const editorPane = readFileSync(path.join(editorDir, "EditorPane.tsx"), "utf8");
const vimLoader = readFileSync(
  path.join(editorDir, "lib/useVimExtension.ts"),
  "utf8",
);
const viteConfig = readFileSync(
  path.join(editorDir, "../../../vite.config.ts"),
  "utf8",
);

describe("editor progressive loading boundary", () => {
  it("loads the shared document alongside the lazy CodeMirror runtime", () => {
    expect(lazyView).toContain("const document = useDocument({");
    expect(lazyView).toContain("<Suspense");
    expect(lazyView).toContain("document={document}");
  });

  it("waits for CodeMirror instead of rendering a separate text view", () => {
    expect(lazyView).not.toContain("<pre");
    expect(lazyView).not.toContain("document.doc.content");
  });

  it("loads syntax highlighting after the CodeMirror first frame", () => {
    expect(editorPane).not.toContain("Warm the language chunk");
    expect(editorPane).toContain("const frame = requestAnimationFrame");
    expect(editorPane).toContain("languageCompartment.reconfigure(result.ext)");
  });

  it("keeps Vim and CodeMirror languages out of manual base chunks", () => {
    expect(editorPane).not.toContain('from "@replit/codemirror-vim"');
    expect(vimLoader).toContain('import("./vim")');
    expect(viteConfig).not.toContain('return "codemirror"');
    expect(viteConfig).not.toContain("cm-lang-");
  });
});
