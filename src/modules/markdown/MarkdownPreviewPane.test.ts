import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const previewSource = readFileSync(
  path.join(here, "MarkdownPreviewPane.tsx"),
  "utf8",
);
const rendererSource = readFileSync(
  path.join(here, "MarkdownDocumentRenderer.tsx"),
  "utf8",
);

describe("Markdown preview architecture", () => {
  it("uses independent outline and document panels", () => {
    expect(previewSource).toContain("<MarkdownSplitLayout");
    expect(previewSource).toContain("<MarkdownDocumentRenderer");
    expect(previewSource).not.toMatch(/max-w-\[860px\]/);
    expect(previewSource).not.toMatch(/transition-\[left\]/);
  });

  it("removes the old overlay and document-shift state machine", () => {
    for (const removed of [
      "calculateOutlineShift",
      "readMarkdownOutline",
      "outlinePanelOpen",
      "outlineShift",
      "MarkdownHeading",
      "OUTLINE_PHASE_MS",
    ]) {
      expect(previewSource).not.toContain(removed);
    }
  });

  it("keeps short files static and mounts long files progressively", () => {
    expect(rendererSource).toMatch(/mode="static"/);
    expect(rendererSource).toMatch(/mode="streaming"/);
    expect(rendererSource).toContain(
      "BlockComponent={MemoizedProgressiveMarkdownBlock}",
    );
    expect(
      rendererSource.match(/parseIncompleteMarkdown=\{false\}/g),
    ).toHaveLength(2);
  });
});
