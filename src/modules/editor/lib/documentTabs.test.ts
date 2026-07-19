import type { Tab } from "@/modules/workbench/types";
import { describe, expect, it } from "vitest";
import {
  countDirtyDocuments,
  hasOtherDocumentView,
  isDocumentTab,
} from "./documentTabs";

const editor = {
  id: 1,
  kind: "editor",
  spaceId: "one",
  title: "readme.md",
  path: "C:\\work\\README.md",
  dirty: true,
  preview: false,
} satisfies Tab;

describe("document tab identity", () => {
  it("matches Editor and Markdown views across groups by normalized path", () => {
    const markdown = {
      id: 2,
      kind: "markdown",
      spaceId: "two",
      title: "readme.md",
      path: "c:/work/README.md",
      dirty: true,
    } satisfies Tab;

    expect(isDocumentTab(markdown)).toBe(true);
    expect(hasOtherDocumentView([editor, markdown], editor)).toBe(true);
    expect(countDirtyDocuments([editor, markdown])).toBe(1);
  });

  it("does not treat an unrelated document as another view", () => {
    const other = {
      ...editor,
      id: 3,
      path: "C:/work/other.md",
    } satisfies Tab;
    expect(hasOtherDocumentView([editor, other], editor)).toBe(false);
  });
});
