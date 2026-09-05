/**
 * 本文件把含内部 Subagent 事件的 UIMessage 历史转换为 provider 消息。
 * 结果事件投影为 append-only user 消息，display-only 进度和活动耗时在边界处显式剔除。
 */

import { isSteeringPart } from "@/modules/ai/lib/turnInbox";
import type { UIMessage } from "@ai-sdk/react";
import { convertToModelMessages, type ModelMessage } from "ai";
import {
  formatSubagentResultEvent,
  isSubagentResultDataPart,
} from "@/modules/ai/agents/subagentRuntime";
import { isSubagentDisplayDataPart } from "@/modules/ai/agents/subagentDisplay";
import { activityDurationFromPart } from "@/modules/ai/lib/sessionMessages";

/** 将 UI 历史按内部事件切开，保证磁盘记录与 provider 看到相同的消息顺序。 */
export async function convertToAgentModelMessages(
  messages: readonly UIMessage[],
): Promise<ModelMessage[]> {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    const sourceParts =
      message.role === "user" &&
      (message.metadata as { guided?: boolean })?.guided
        ? [
            {
              type: "text" as const,
              text: "The user provided additional guidance for the current task. Apply this supplement or correction to your ongoing work:\n",
            },
            ...message.parts,
          ]
        : message.parts;
    const providerParts = sourceParts.filter(
      (part) =>
        !isSubagentDisplayDataPart(part) &&
        activityDurationFromPart(part) === undefined,
    );
    if (message.role === "assistant" && !hasModelContent(providerParts)) {
      continue;
    }
    if (
      message.role !== "assistant" ||
      !providerParts.some(
        (part) => isSubagentResultDataPart(part) || isSteeringPart(part),
      )
    ) {
      converted.push(
        ...(await convertToModelMessages([
          { ...message, parts: providerParts },
        ])),
      );
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

    for (const part of providerParts) {
      if (isSteeringPart(part)) {
        await flush();
        converted.push(
          ...(await convertToAgentModelMessages([part.data.message])),
        );
        continue;
      }
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
