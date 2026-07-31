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
 * `data-block` 用于区分无语言标识的围栏代码，variant 只控制场景交互。
 */
export function MarkdownCode({
  className,
  children,
  node: _node,
  onRun,
  variant = "chat",
  ...rest
}: {
  className?: string;
  children?: ReactNode;
  node?: unknown;
  onRun?: (command: string) => boolean;
  variant?: "chat" | "document";
  "data-block"?: string;
}) {
  const match = className?.match(/language-([^\s]+)/);
  const block = "data-block" in rest;
  if (!block) {
    return (
      <code
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const code = markdownCodeText(children).replace(/\n$/, "");
  return (
    <ChatCodeBlock
      code={code}
      lang={match?.[1] ?? null}
      onRun={onRun}
      variant={variant}
    />
  );
}
