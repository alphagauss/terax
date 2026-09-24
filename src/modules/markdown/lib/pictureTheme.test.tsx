/** 验证 picture 候选在主题切换时随文档重新解析。 */
// @vitest-environment happy-dom
import { prepareMarkdownDocument } from "@/modules/markdown/lib/document";
import { MarkdownDocumentRenderer } from "@/modules/markdown/MarkdownDocumentRenderer";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("@/modules/markdown/MarkdownPreviewImage", async () => {
  const { createElement } = await import("react");
  return {
    MarkdownImageProvider: ({ children }: { children: ReactNode }) => children,
    MarkdownPreviewImage: ({ src, alt }: { src?: string; alt?: string }) =>
      createElement("img", { src, alt }),
  };
});

it("updates the chosen picture source when the theme changes", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const markdown = prepareMarkdownDocument(
    '<picture><source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png"><img src="assets/hero.png" alt="kiso"></picture>',
  );
  const scrollContainer = document.createElement("div");
  const render = (mode: "dark" | "light") =>
    createElement(MarkdownDocumentRenderer, {
      document: markdown,
      documentPath: "D:/opensource/kiso/README.zh.md",
      mode,
      visible: true,
      scrollContainer,
      onFragmentNavigate: () => {},
      onFileReferenceOpen: () => {},
      onFileReferenceOpenDirectory: () => {},
    });
  await act(async () => root.render(render("dark")));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "terax-relative-image:assets%2Fhero-dark.png",
  );
  await act(async () => root.render(render("light")));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    "terax-relative-image:assets%2Fhero.png",
  );
  await act(async () => root.unmount());
});
