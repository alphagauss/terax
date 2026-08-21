/**
 * 本文件测试命令面板最近使用排序和无存储环境下的降级。
 * 测试运行于无 localStorage 的 Node 环境，不修改真实用户偏好。
 */

import { describe, expect, it } from "vitest";
import { mruRank, mruSnapshot, recordUse } from "./mru";

describe("mruRank", () => {
  it("返回已记录标识的时间戳", () => {
    expect(mruRank({ a: 5, b: 9 }, "b")).toBe(9);
  });

  it("缺失标识或空快照返回零", () => {
    expect(mruRank({ a: 5 }, "missing")).toBe(0);
    expect(mruRank({}, "anything")).toBe(0);
  });
});

describe("无 localStorage 时的 MRU 持久化", () => {
  it("读取为空且记录操作不抛错", () => {
    expect(mruSnapshot()).toEqual({});
    expect(() => recordUse("some.command")).not.toThrow();
  });
});
