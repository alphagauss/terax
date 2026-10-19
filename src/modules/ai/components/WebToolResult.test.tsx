import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WebToolResult } from "./WebToolResult";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it("renders source links and truncation without interpreting external HTML or loading images", () => {
  const html = renderToStaticMarkup(
    <WebToolResult
      output={{
        results: [
          {
            title: "Source",
            url: "https://example.com",
            content: "<img src='https://tracker.example'>",
            truncated: true,
          },
          {
            title: "Unsafe",
            url: "javascript:alert(1)",
            content: "hidden",
            truncated: false,
          },
        ],
      }}
    />,
  );
  expect(html).toContain('href="https://example.com"');
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("javascript:");
  expect(html).toContain("chat.web.truncated");
});

it("distinguishes an empty successful search", () => {
  expect(
    renderToStaticMarkup(<WebToolResult output={{ results: [] }} />),
  ).toContain("chat.web.empty");
});
