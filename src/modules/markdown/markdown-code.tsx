/**
 * 本文件连接 Streamdown 代码节点与 Terax 的代码块渲染器。
 *
 * 行内代码直接展示，围栏代码按聊天或文档上下文选择交互行为。
 */

"use client";

import { isValidElement, type ReactNode } from "react";

import { ChatCodeBlock } from "./chat-code";

/** 将 Streamdown 代码节点递归还原为纯文本。 */
export function markdownCodeText(children?: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => markdownCodeText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return markdownCodeText(children.props.children);
  }
  return "";
}

/**
 * Markdown 代码节点渲染器。
 *
 * `data-block` 用于区分无语言标识的围栏代码，variant 只控制 Mermaid 场景能力。
 */
export function MarkdownCode({
  className,
  children,
  node: _node,
  variant = "chat",
  ...rest
}: {
  className?: string;
  children?: ReactNode;
  node?: unknown;
  variant?: "chat" | "document";
  "data-block"?: string;
}) {
  const match = className?.match(/language-([^\s]+)/);
  const block = "data-block" in rest;
  if (!block) {
    return (
      <code {...rest} data-streamdown="inline-code">
        {children}
      </code>
    );
  }

  const code = markdownCodeText(children).replace(/\n$/, "");
  return (
    <ChatCodeBlock code={code} lang={match?.[1] ?? null} variant={variant} />
  );
}
