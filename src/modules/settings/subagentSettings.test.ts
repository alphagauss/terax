/**
 * 本文件测试 Subagent 并发设置的默认值和持久化输入归一化边界。
 * 测试锁定每聊天至少一个、最多八个且默认三个的产品约束。
 */

import { describe, expect, it } from "vitest";
import {
  clampMaxConcurrentSubagents,
  DEFAULT_PREFERENCES,
  MAX_CONCURRENT_SUBAGENTS_MAX,
  MAX_CONCURRENT_SUBAGENTS_MIN,
} from "./store";

describe("Subagent settings", () => {
  it("defaults to following the chat model with three concurrent tasks", () => {
    expect(DEFAULT_PREFERENCES.defaultSubagentModel).toBeNull();
    expect(DEFAULT_PREFERENCES.maxConcurrentSubagents).toBe(3);
  });

  it("clamps invalid concurrency values to the supported range", () => {
    expect(clampMaxConcurrentSubagents(0)).toBe(MAX_CONCURRENT_SUBAGENTS_MIN);
    expect(clampMaxConcurrentSubagents(99)).toBe(MAX_CONCURRENT_SUBAGENTS_MAX);
    expect(clampMaxConcurrentSubagents(Number.NaN)).toBe(3);
  });
});
