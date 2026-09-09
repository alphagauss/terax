import { expect, it } from "vitest";
import { summarizePerformance, type UsageRecord } from "./usage";
import {
  conversationEventPart,
  materializeTurnMetadata,
  messageMetadata,
  projectConversationDisplay,
  projectSessionMessages,
  convertToAgentModelMessages,
} from "./conversation";

const record = (patch: Partial<UsageRecord>): UsageRecord => ({
  id: "call",
  turnId: "turn",
  model: { providerId: "test", modelId: "test" },
  values: { inputTokens: 0, outputTokens: 0 },
  toolCalls: 0,
  estimated: [],
  contextWindow: 10000,
  ...patch,
});

it("weights speed by SDK generation time and leaves missing timing unknown", () => {
  const records = [
    record({
      values: { inputTokens: 0, outputTokens: 100 },
      timing: { responseTimeMs: 2000, timeToFirstOutputMs: 1000 },
    }),
    record({
      values: { inputTokens: 0, outputTokens: 200 },
      timing: { responseTimeMs: 4500, timeToFirstOutputMs: 500 },
    }),
    record({
      values: { inputTokens: 0, outputTokens: 999 },
      estimated: ["outputTokens"],
    }),
  ];
  expect(summarizePerformance(records)).toEqual({
    firstOutputMs: 1000,
    tokensPerSecond: 60,
    partial: true,
  });
  expect(summarizePerformance([record({})])).toMatchObject({
    firstOutputMs: undefined,
    tokensPerSecond: undefined,
  });
  expect(
    summarizePerformance([
      record({
        values: { inputTokens: 0, outputTokens: 10 },
        timing: { responseTimeMs: 1, timeToFirstOutputMs: 1 },
      }),
    ]).tokensPerSecond,
  ).toBeUndefined();
});

it("keeps historical turn IDs and exposes metrics only on the last guided answer", async () => {
  const restored = projectSessionMessages("session", [
    { role: "user", content: "first", timestamp: "now", turn_id: "first" },
    {
      role: "assistant",
      content: "answer one",
      timestamp: "now",
      turn_id: "first",
    },
    { role: "user", content: "second", timestamp: "now", turn_id: "second" },
    {
      role: "assistant",
      content: "answer two",
      timestamp: "now",
      turn_id: "second",
    },
  ]);
  expect(
    restored
      .filter((message) => message.role === "assistant")
      .map((message) => messageMetadata(message).turnId),
  ).toEqual(["first", "second"]);
  const live = materializeTurnMetadata(
    [
      {
        id: "answer",
        role: "assistant",
        parts: [
          { type: "text", text: "working" },
          conversationEventPart({
            event: "user_steering",
            message: {
              id: "guide",
              role: "user",
              parts: [{ type: "text", text: "continue" }],
            },
          }),
          { type: "text", text: "done" },
        ],
      },
    ],
    "guided-turn",
  );
  const answers = projectConversationDisplay(live).filter(
    (message) => message.role === "assistant",
  );
  expect(answers.map((message) => messageMetadata(message).turnId)).toEqual([
    undefined,
    "guided-turn",
  ]);
  expect(JSON.stringify(await convertToAgentModelMessages(live))).not.toContain(
    "guided-turn",
  );
});
