import { expect, it, vi } from "vitest";
import {
  buildMessageTools,
  messageInputSchema,
} from "@/modules/ai/tools/message";
import {
  availableAgentTools,
  resolveSubagentTools,
} from "@/modules/ai/lib/agentTools";

it("binds message delivery to a runtime capability and supports attachment-only requests", async () => {
  const send = vi.fn(async () => ({
    status: "accepted" as const,
    parts: [{ index: 0, status: "accepted" as const }],
  }));
  const tools = buildMessageTools({
    getCwd: () => "/account",
    getSessionId: () => "session",
    getPermissionMode: () => "full-access",
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    supportsApprovals: false,
    getMessageSender: () => send,
  });
  const input = messageInputSchema.parse({
    attachments: [{ path: "attachments/file.pdf" }],
  });
  await tools.message.execute?.(input, {
    toolCallId: "call",
    messages: [],
    context: undefined as never,
  });
  expect(send).toHaveBeenCalledWith(
    {
      attachments: [{ path: "attachments/file.pdf", presentation: "file" }],
    },
    undefined,
  );
  expect(messageInputSchema.safeParse({ text: " " }).success).toBe(false);
  expect(availableAgentTools(false)).not.toContain("message");
  expect(availableAgentTools(true)).toContain("message");
  expect(resolveSubagentTools(["message", "read_file"], "full-access")).toEqual(
    ["read_file"],
  );
});
