/** 手动压缩使用空响应容器，避免 SDK 无输入发送继承上一条助手回答。 */
import type { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";

export async function sendCompaction(chat: Chat<UIMessage>): Promise<void> {
  const id = crypto.randomUUID();
  chat.messages = [...chat.messages, { id, role: "assistant", parts: [] }];
  try {
    await chat.sendMessage(undefined, { body: { compaction: true } });
  } finally {
    // 空操作和生成失败不保留占位消息；成功检查点仍由同一运行生命周期提交。
    chat.messages = chat.messages.filter(
      (message) => message.id !== id || message.parts.length > 0,
    );
  }
}
