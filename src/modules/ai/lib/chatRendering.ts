/**
 * 本文件提供 AI 聊天渲染热路径使用的轻量性能参数与估算函数。
 * 负责限制流式 React 提交频率并估算上下文大小，不参与真实 token 计费。
 */

import type { UIMessage } from "ai";

/**
 * 流式消息提交给 React 的最小间隔。
 *
 * 约 30 FPS 足以保持文字连续出现，同时避免每个网络 delta 都触发
 * Markdown 解析、布局测量和滚动更新。
 */
export const STREAM_RENDER_INTERVAL_MS = 32;

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 以字符数粗略估算一组 UI 消息的 token 数。
 *
 * 该函数只应在会话静止时调用。流式期间遍历完整历史会把 O(n) 工作
 * 放大到每个 delta，工具参数若意外包含不可序列化值则按零字符处理。
 */
export function estimateUiMessageTokens(
  messages: readonly UIMessage[],
): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        chars += (part as { text?: string }).text?.length ?? 0;
      } else if (
        part.type === "dynamic-tool" ||
        (typeof part.type === "string" && part.type.startsWith("tool-"))
      ) {
        const toolPart = part as unknown as {
          input?: unknown;
          output?: unknown;
        };
        if (toolPart.input !== undefined) {
          chars += serializedLength(toolPart.input);
        }
        if (toolPart.output !== undefined) {
          chars += serializedLength(toolPart.output);
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}
