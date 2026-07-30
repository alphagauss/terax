/**
 * 本文件实现 GitHub 风格 Markdown Alerts 的 HAST 转换。
 *
 * 只生成固定标签和固定类名，转换结果仍需经过统一 sanitizer。
 */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const ALERT_MARKER =
  /^\[!(note|tip|important|warning|caution)\][^\S\n]*(?:\n|$)/i;

/** 将顶层 GFM Alert blockquote 转换为受控的提示块结构。 */
export function rehypeGithubAlerts() {
  return (tree: unknown) => visit(tree as HastNode, false);
}

function visit(node: HastNode, insideBlockquote: boolean): void {
  const isBlockquote = node.type === "element" && node.tagName === "blockquote";
  if (isBlockquote && !insideBlockquote) transformAlert(node);
  for (const child of node.children ?? []) {
    visit(child, insideBlockquote || isBlockquote);
  }
}

function transformAlert(blockquote: HastNode): void {
  const children = blockquote.children ?? [];
  const paragraphIndex = children.findIndex((child) => {
    if (child.type === "element") return true;
    return child.type !== "text" || Boolean(child.value?.trim());
  });
  if (paragraphIndex < 0) return;

  const paragraph = children[paragraphIndex];
  if (paragraph.tagName !== "p" || !paragraph.children?.length) return;

  const markerNode = paragraph.children[0];
  if (markerNode.type !== "text" || typeof markerNode.value !== "string") {
    return;
  }
  const match = ALERT_MARKER.exec(markerNode.value);
  if (!match) return;

  if (match[0].endsWith("\n")) {
    markerNode.value = markerNode.value.slice(match[0].length);
    if (!markerNode.value) paragraph.children.shift();
  } else {
    const next = paragraph.children[1];
    if (!next) {
      children.splice(paragraphIndex, 1);
    } else if (next.type === "element" && next.tagName === "br") {
      paragraph.children.splice(0, 2);
      const firstContent = paragraph.children[0];
      if (firstContent?.type === "text" && firstContent.value) {
        firstContent.value = firstContent.value.replace(/^\n/, "");
      }
    } else {
      return;
    }
  }

  const type = match[1].toLowerCase();
  blockquote.tagName = "div";
  blockquote.properties = {
    className: ["markdown-alert", `markdown-alert-${type}`],
  };
  blockquote.children = [
    {
      type: "element",
      tagName: "p",
      properties: { className: ["markdown-alert-title"] },
      children: [
        {
          type: "text",
          value: `${type[0].toUpperCase()}${type.slice(1)}`,
        },
      ],
    },
    ...children,
  ];
}
