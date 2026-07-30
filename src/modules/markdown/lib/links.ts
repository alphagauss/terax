/**
 * 本文件定义 Markdown 预览链接的允许策略。
 *
 * 文档片段留在当前预览，只有 http、https 和 mailto 可交给系统浏览器。
 */

export type MarkdownLinkTarget =
  | { kind: "fragment"; fragment: string }
  | { kind: "external"; url: string }
  | { kind: "blocked" };

const EXTERNAL_URL = /^(https?:|mailto:)/i;

type ExternalOpenGesture = {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
};

/** 将 Markdown href 分类为片段、允许的外链或不可执行链接。 */
export function classifyMarkdownLink(
  href: string | undefined,
): MarkdownLinkTarget {
  if (!href) return { kind: "blocked" };
  if (href.startsWith("#")) {
    return { kind: "fragment", fragment: href.slice(1) };
  }
  return EXTERNAL_URL.test(href)
    ? { kind: "external", url: href }
    : { kind: "blocked" };
}

/** 仅允许跨平台主修饰键与鼠标左键组合打开系统浏览器。 */
export function isMarkdownExternalOpenGesture(
  gesture: ExternalOpenGesture,
): boolean {
  return gesture.button === 0 && (gesture.ctrlKey || gesture.metaKey);
}
