"use client";

import { isValidElement, type ReactNode } from "react";

import { ChatCodeBlock } from "./chat-code";

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
 * Streamdown `components.code` override. `data-block` distinguishes fenced
 * blocks even when they do not declare a language.
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
  variant?: "chat" | "preview";
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
      variant={variant}
    />
  );
}
