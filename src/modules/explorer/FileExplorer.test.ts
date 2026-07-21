import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, "FileExplorer.tsx"), "utf8");
const editorSource = readFileSync(
  path.join(here, "../editor/EditorPane.tsx"),
  "utf8",
);
const viewRegistrySource = readFileSync(
  path.join(here, "../workbench/viewRegistry.tsx"),
  "utf8",
);

function expectNoHooksAfter(sourceText: string, marker: string) {
  const earlyReturn = sourceText.indexOf(marker);

  expect(earlyReturn).toBeGreaterThan(-1);
  expect(sourceText.slice(earlyReturn)).not.toMatch(/\buse[A-Z]\w*\s*\(/);
}

describe("file opening render path", () => {
  it("keeps hooks stable while the remote root and file resolve", () => {
    expectNoHooksAfter(source, "if (!rootPath) {");
    expectNoHooksAfter(editorSource, 'if (doc.status === "loading") {');
  });

  it("routes editable and Markdown files through isolated views", () => {
    expect(viewRegistrySource).toContain('tab.kind === "editor"');
    expect(viewRegistrySource).toContain("<EditorView");
    expect(viewRegistrySource).toContain('tab.kind === "markdown"');
    expect(viewRegistrySource).toContain("<MarkdownView");
  });
});
