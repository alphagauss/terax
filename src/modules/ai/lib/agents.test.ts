/**
 * 本文件测试内置与自定义 AI Agent 的解析规则。
 * 锁定内置标识唯一性和无效活动标识的安全回退。
 */

import { describe, expect, it } from "vitest";
import { type Agent, BUILTIN_AGENTS, findAgent } from "./agents";

const custom: Agent = {
  id: "a-1",
  name: "Mine",
  description: "",
  instructions: "",
  icon: "spark",
  builtIn: false,
};

const all = [...BUILTIN_AGENTS, custom];

describe("BUILTIN_AGENTS", () => {
  it("具有唯一标识并统一标记为内置 Agent", () => {
    const ids = BUILTIN_AGENTS.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(BUILTIN_AGENTS.every((agent) => agent.builtIn)).toBe(true);
  });
});

describe("findAgent", () => {
  it("返回标识匹配的 Agent", () => {
    expect(findAgent(all, "a-1")).toBe(custom);
  });

  it.each(["does-not-exist", null, undefined, ""])(
    "对无效标识 %s 回退到首个内置 Agent",
    (id) => {
      expect(findAgent(all, id)).toBe(BUILTIN_AGENTS[0]);
    },
  );
});
