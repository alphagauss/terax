/**
 * 本文件测试 Markdown 相对图片解析。
 *
 * 锁定跨平台分隔符、编码路径、父目录和敏感路径拒绝规则。
 */

import {
  decodeRelativeMarkdownImage,
  encodeRelativeMarkdownImage,
  isRelativeMarkdownImageSource,
  rehypeRelativeMarkdownImages,
  resolveMarkdownImagePath,
} from "@/modules/markdown/lib/localImages";
import { describe, expect, it } from "vitest";

describe("Markdown relative image paths", () => {
  it("recognizes only document-relative sources", () => {
    expect(isRelativeMarkdownImageSource("./assets/a.png")).toBe(true);
    expect(isRelativeMarkdownImageSource("../a.png")).toBe(true);
    expect(isRelativeMarkdownImageSource("images/a.png")).toBe(true);
    expect(isRelativeMarkdownImageSource("https://example.com/a.png")).toBe(
      false,
    );
    expect(isRelativeMarkdownImageSource("data:image/png;base64,AA==")).toBe(
      false,
    );
    expect(isRelativeMarkdownImageSource("/assets/a.png")).toBe(false);
    expect(isRelativeMarkdownImageSource("C:/assets/a.png")).toBe(false);
  });

  it("round-trips the internal protocol without exposing malformed values", () => {
    const encoded = encodeRelativeMarkdownImage("./my image.png");
    expect(decodeRelativeMarkdownImage(encoded)).toBe("./my image.png");
    expect(decodeRelativeMarkdownImage("https://example.com/a.png")).toBeNull();
    expect(
      decodeRelativeMarkdownImage("terax-relative-image:%E0%A4%A"),
    ).toBeNull();
  });

  it("removes an uncontrolled srcset when marking a relative image", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "img",
          properties: {
            src: "./image.png",
            srcSet: "./large.png 2x",
          },
        },
      ],
    };
    rehypeRelativeMarkdownImages("dark")(tree);
    expect(tree.children[0]?.properties).toEqual({
      src: encodeRelativeMarkdownImage("./image.png"),
    });
  });

  it("selects a picture candidate before the controlled image component", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "picture",
          children: [
            {
              type: "element",
              tagName: "source",
              properties: {
                srcSet: "https://example.com/large.png 2x",
                media: "(min-width: 800px)",
              },
            },
            {
              type: "element",
              tagName: "img",
              properties: { src: "./fallback.png", alt: "Fallback" },
            },
          ],
        },
      ],
    };

    rehypeRelativeMarkdownImages("dark")(tree);
    expect(tree.children[0]).toMatchObject({
      tagName: "img",
      properties: {
        src: encodeRelativeMarkdownImage("./fallback.png"),
        alt: "Fallback",
      },
    });
  });

  it("resolves Unix, Windows and UNC document paths", () => {
    expect(
      resolveMarkdownImagePath(
        "/workspace/docs/readme.md",
        "../assets/my%20image.png",
      ),
    ).toBe("/workspace/assets/my image.png");
    expect(
      resolveMarkdownImagePath(
        "C:\\workspace\\docs\\readme.md",
        "..\\assets\\diagram.svg",
      ),
    ).toBe("C:/workspace/assets/diagram.svg");
    expect(
      resolveMarkdownImagePath(
        "\\\\server\\share\\docs\\readme.md",
        "../image.webp",
      ),
    ).toBe("//server/share/image.webp");
    expect(
      resolveMarkdownImagePath(
        "\\\\server\\share\\docs\\readme.md",
        "../../../../image.webp",
      ),
    ).toBe("//server/share/image.webp");
  });

  it("rejects unsupported files, absolute paths and sensitive locations", () => {
    expect(
      resolveMarkdownImagePath("/workspace/readme.md", "./notes.txt"),
    ).toBeNull();
    expect(
      resolveMarkdownImagePath("/workspace/readme.md", "/tmp/image.png"),
    ).toBeNull();
    expect(
      resolveMarkdownImagePath("/workspace/readme.md", "../.ssh/qr.png"),
    ).toBeNull();
    expect(
      resolveMarkdownImagePath("/workspace/readme.md", "./.env.png"),
    ).toBeNull();
  });
});
