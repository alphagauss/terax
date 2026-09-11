/**
 * 本文件提供 AI 会话滚动控件使用的纯数据投影与弹簧参数。
 * 负责生成用户消息导航项和判断恢复跟随按钮的显示条件，不直接操作 DOM。
 */

import type { UIMessage } from "ai";
import { messageTextWithoutAttachments } from "@/modules/ai/lib/messageAttachments";
import { TERAX_CMD_RE } from "./slashCommands";

const USER_CONTEXT_BLOCK_RE = /<(selection|snippet)\b[^>]*>[\s\S]*?<\/\1>/gi;

export interface UserMessageAnchor {
  id: string;
  index: number;
  text: string;
}

/**
 * 会话自动跟随使用的轻量弹簧参数。
 *
 * `use-stick-to-bottom` 在单个 rAF 循环内复用这些参数，内容继续增长时只更新
 * 目标位置，不会为每个 ResizeObserver 通知创建新的滚动动画。
 */
export const CHAT_SCROLL_SPRING = {
  damping: 0.78,
  stiffness: 0.09,
  mass: 0.95,
} as const;

/**
 * 判断是否展示恢复跟随控件。
 *
 * 到达底部后必须立即隐藏；运行状态只决定控件内容，不改变可见性。
 */
export function shouldShowChatScrollControls(isAtBottom: boolean): boolean {
  return !isAtBottom;
}

function userMessageText(message: UIMessage): string {
  const rawText = messageTextWithoutAttachments(message);
  const commandMatch = rawText.match(TERAX_CMD_RE);
  const withoutCommand = commandMatch
    ? rawText.slice(commandMatch[0].length)
    : rawText;
  return withoutCommand.replace(USER_CONTEXT_BLOCK_RE, "").trim();
}

/**
 * 从会话消息生成按发送顺序排列的用户消息导航项。
 *
 * 附件、选区和片段不会进入菜单摘要，避免大段显式附着内容挤占导航列表。
 */
export function buildUserMessageAnchors(
  messages: readonly UIMessage[],
  emptyLabel: string,
): UserMessageAnchor[] {
  const anchors: UserMessageAnchor[] = [];
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    anchors.push({
      id: message.id,
      index: anchors.length,
      text: userMessageText(message) || emptyLabel,
    });
  }
  return anchors;
}
