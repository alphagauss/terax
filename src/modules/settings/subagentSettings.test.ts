/**
 * 本文件测试 Agent 步数与 Subagent 并发设置的默认值和归一化边界。
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_STEPS_MAX,
  AGENT_STEPS_MIN,
  clampAgentSteps,
  clampMaxConcurrentSubagents,
  DEFAULT_PREFERENCES,
  MAX_CONCURRENT_SUBAGENTS_MAX,
  MAX_CONCURRENT_SUBAGENTS_MIN,
} from "./store";

describe("Subagent settings", () => {
  it("defaults to following the chat model with three concurrent tasks", () => {
    expect(DEFAULT_PREFERENCES.modelUsages.subagent.model).toBeNull();
    expect(DEFAULT_PREFERENCES.maxConcurrentSubagents).toBe(3);
    expect(DEFAULT_PREFERENCES.maxAgentSteps).toBe(64);
    expect(DEFAULT_PREFERENCES.maxSubagentSteps).toBe(32);
    expect(DEFAULT_PREFERENCES.desktopPermissionMode).toBe("ask");
    expect(DEFAULT_PREFERENCES.desktopModel).toBeNull();
    expect(DEFAULT_PREFERENCES.desktopModelParameterSelections).toEqual({});
  });

  it("clamps Agent step limits with the configured fallback", () => {
    expect(clampAgentSteps(0, 64)).toBe(AGENT_STEPS_MIN);
    expect(clampAgentSteps(999, 64)).toBe(AGENT_STEPS_MAX);
    expect(clampAgentSteps(31.6, 64)).toBe(32);
    expect(clampAgentSteps(Number.NaN, 64)).toBe(64);
  });

  it("clamps invalid concurrency values to the supported range", () => {
    expect(clampMaxConcurrentSubagents(0)).toBe(MAX_CONCURRENT_SUBAGENTS_MIN);
    expect(clampMaxConcurrentSubagents(99)).toBe(MAX_CONCURRENT_SUBAGENTS_MAX);
    expect(clampMaxConcurrentSubagents(Number.NaN)).toBe(3);
  });
});
