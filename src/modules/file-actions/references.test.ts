/** 验证文件引用只在文档上下文中解析相对路径，并保持行号语义。 */
import {
  fileReferenceBaseDirectory,
  parseFileReference,
  parseRelativeFileReference,
  rehypeFileReferences,
  decodeFileReference,
} from "@/modules/file-actions/references";
import { describe, expect, it } from "vitest";

describe("file references", () => {
  it("keeps chat-style references restricted to absolute paths", () => {
    expect(parseFileReference("docs/README.md:4")).toBeNull();
    expect(parseFileReference("D:/project/README.md:4")).toMatchObject({
      path: "D:/project/README.md",
      line: 4,
    });
  });

  it("resolves document-relative paths and clamps parent traversal at root", () => {
    expect(fileReferenceBaseDirectory("D:/project/docs/current.md")).toBe(
      "D:/project/docs",
    );
    expect(fileReferenceBaseDirectory("D:/current.md")).toBe("D:/");
    expect(
      parseRelativeFileReference("D:/project/docs", "../README.md:4"),
    ).toEqual({
      path: "D:/project/README.md",
      line: 4,
      literalPath: "D:/project/README.md:4",
    });
    expect(
      parseRelativeFileReference("/workspace/docs", "../../../a.md"),
    ).toEqual({
      path: "/a.md",
      literalPath: "/a.md",
    });
  });

  it("resolves session-relative paths from the frozen cwd", () => {
    expect(
      parseRelativeFileReference("D:/workspace/project", "./src/config.ts:12"),
    ).toEqual({
      path: "D:/workspace/project/src/config.ts",
      line: 12,
      literalPath: "D:/workspace/project/src/config.ts:12",
    });
  });

  it("does not reinterpret fragments or external URLs as files", () => {
    expect(parseRelativeFileReference("/workspace", "#section")).toBeNull();
    expect(
      parseRelativeFileReference("/workspace", "https://example.com"),
    ).toBeNull();
  });

  it("strips a leading slash from drive paths only for local Windows links", () => {
    const link = {
      type: "element",
      tagName: "a",
      properties: { href: "/d:/project/file.ts:70" },
    };
    rehypeFileReferences({ windowsLocal: true })(link);
    expect(decodeFileReference(link.properties.href)).toMatchObject({
      path: "d:/project/file.ts",
      line: 70,
    });

    const remoteLink = {
      type: "element",
      tagName: "a",
      properties: { href: "/d:/project/file.ts:70" },
    };
    rehypeFileReferences()(remoteLink);
    expect(decodeFileReference(remoteLink.properties.href)).toMatchObject({
      path: "/d:/project/file.ts",
      line: 70,
    });
  });
});
