/**
 * 本文件把含内部 Subagent 事件的 UIMessage 历史转换为 provider 消息。
 * 事件在 UI 中属于隐藏 data part，在模型协议中投影为 append-only user 消息。
 */

import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages, type ModelMessage } from "ai";
import {
  formatSubagentResultEvent,
  isSubagentResultDataPart,
} from "../agents/subagentRuntime";

/** 将 UI 历史按内部事件切开，保证磁盘记录与 provider 看到相同的消息顺序。 */
export async function convertToAgentModelMessages(
  messages: readonly UIMessage[],
): Promise<ModelMessage[]> {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    if (
      message.role !== "assistant" ||
      !message.parts.some(isSubagentResultDataPart)
    ) {
      converted.push(...(await convertToModelMessages([message])));
      continue;
    }

    let segment: UIMessage["parts"] = [];
    const flush = async () => {
      if (!hasModelContent(segment)) {
        segment = [];
        return;
      }
      converted.push(
        ...(await convertToModelMessages([{ ...message, parts: segment }])),
      );
      segment = [];
    };

    for (const part of message.parts) {
      if (!isSubagentResultDataPart(part)) {
        segment.push(part);
        continue;
      }
      await flush();
      converted.push({
        role: "user",
        content: formatSubagentResultEvent(part.data.event),
      });
    }
    await flush();
  }
  return converted;
}

function hasModelContent(parts: UIMessage["parts"]): boolean {
  return parts.some((part) => part.type !== "step-start");
}
