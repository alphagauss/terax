/**
 * 本文件测试 Agent 通知去重窗口和缓存边界。
 * 不同标签、内置会话和通知类型必须保持相互独立。
 */

import { describe, expect, it } from "vitest";
import { createAgentNotificationGate } from "./notificationGate";

const TARGET = {
  source: "terminal",
  agent: "codex",
  kind: "attention",
  tabId: 7,
};

describe("createAgentNotificationGate", () => {
  it("抑制冷却时间内的相同通知", () => {
    const shouldDeliver = createAgentNotificationGate(2_000);

    expect(shouldDeliver(TARGET, 1_000)).toBe(true);
    expect(shouldDeliver(TARGET, 2_999)).toBe(false);
    expect(shouldDeliver(TARGET, 3_000)).toBe(true);
  });

  it("分别处理不同目标和通知类型", () => {
    const shouldDeliver = createAgentNotificationGate(2_000);

    expect(shouldDeliver(TARGET, 1_000)).toBe(true);
    expect(shouldDeliver({ ...TARGET, tabId: 8 }, 1_001)).toBe(true);
    expect(shouldDeliver({ ...TARGET, kind: "finished" }, 1_002)).toBe(true);
    expect(
      shouldDeliver(
        { ...TARGET, source: "local", tabId: 0, sessionId: "session-a" },
        1_003,
      ),
    ).toBe(true);
    expect(
      shouldDeliver(
        { ...TARGET, source: "local", tabId: 0, sessionId: "session-b" },
        1_004,
      ),
    ).toBe(true);
  });

  it("系统时钟回拨后恢复投递", () => {
    const shouldDeliver = createAgentNotificationGate(2_000);

    expect(shouldDeliver(TARGET, 5_000)).toBe(true);
    expect(shouldDeliver(TARGET, 4_000)).toBe(true);
  });

  it("限制保留的通知键数量", () => {
    const shouldDeliver = createAgentNotificationGate(2_000, 2);

    expect(shouldDeliver(TARGET, 1_000)).toBe(true);
    expect(shouldDeliver({ ...TARGET, tabId: 8 }, 1_001)).toBe(true);
    expect(shouldDeliver({ ...TARGET, tabId: 9 }, 1_002)).toBe(true);
    expect(shouldDeliver(TARGET, 1_003)).toBe(true);
  });
});
