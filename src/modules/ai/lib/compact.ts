/**
 * 本文件压缩发送给模型的历史消息和大型工具结果。
 * 超出输入预算后先省略较早工具结果，再裁剪完整旧轮次，保留最近消息与工具配对。
 */

import type { ModelMessage } from "ai";
import { estimateTokens } from "@/modules/ai/lib/usage";

const ELISION_TEXT = "[elided to save context; see prior tool call in history]";

type ToolPart = {
  type: string;
  output?: unknown;
  [k: string]: unknown;
};

export function estimateMessageTokens(
  messages: readonly ModelMessage[],
): number {
  if (!messages.length) return 0;
  // 图片和文件的编码长度不等于模型 token，不能把 base64 当作正文计数。
  return estimateTokens(
    JSON.stringify(messages, (_key, value) =>
      value &&
      typeof value === "object" &&
      (value.type === "image" || value.type === "file")
        ? { type: value.type }
        : value,
    ),
  );
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
};

export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
  estimate: (messages: ModelMessage[]) => number = estimateMessageTokens,
): CompactResult {
  if (estimate(messages) < contextLimit)
    return { messages, compacted: false, droppedCount: 0 };

  let dropped = 0;
  const out = messages.slice();
  const stopIdx = Math.max(0, out.length - 4);
  for (let i = 0; i < stopIdx; i++) {
    if (out[i].role === "system") continue;
    if (!Array.isArray(out[i].content)) continue;
    let local = false;
    const next = (out[i].content as ToolPart[]).map((part) => {
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (local) {
      out[i] = { ...out[i], content: next } as ModelMessage;
      dropped++;
      if (estimate(out) < 0.8 * contextLimit) break;
    }
  }

  // 按完整用户轮次裁剪，不能留下没有调用的工具结果或删除当前用户请求。
  while (estimate(out) >= 0.8 * contextLimit) {
    const firstUser = out.findIndex((message) => message.role === "user");
    const nextUser = out.findIndex(
      (message, index) =>
        index > Math.max(0, firstUser) && message.role === "user",
    );
    if (nextUser < 0) break;
    const instructions = out
      .slice(0, nextUser)
      .filter((message) => message.role === "system");
    if (instructions.length === nextUser) break;
    out.splice(0, nextUser, ...instructions);
    dropped++;
  }
  return {
    messages: out,
    compacted: dropped > 0,
    droppedCount: dropped,
  };
}
