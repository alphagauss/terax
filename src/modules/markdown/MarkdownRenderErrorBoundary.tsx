/**
 * 本文件隔离 Markdown 渲染异常。
 *
 * 错误只替换渲染视图，源码视图保持可用；文件内容变化后允许重新尝试。
 */

import { Component, type ReactNode } from "react";

type Props = {
  content: string;
  fallback: ReactNode;
  children: ReactNode;
};

type State = {
  content: string;
  failed: boolean;
};

/** 捕获单个 Markdown 文档的渲染错误，并在内容更新时恢复。 */
export class MarkdownRenderErrorBoundary extends Component<Props, State> {
  state: State = {
    content: this.props.content,
    failed: false,
  };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    if (props.content === state.content) return null;
    return { content: props.content, failed: false };
  }

  componentDidCatch(error: unknown): void {
    console.error("[markdown-preview] render failed", error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
