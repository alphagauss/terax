/**
 * 本文件测试 Alpha 环境可见性设置的默认值与持久化值解析。
 * 重点锁定缺失或无效配置不会让 Alpha 意外出现在远端环境。
 */

import { alphaShowInRemoteFromValues } from "@/modules/alpha/preferences";
import { describe, expect, it } from "vitest";

describe("Alpha visibility preferences", () => {
  it("defaults to Local-only visibility", () => {
    expect(alphaShowInRemoteFromValues({})).toBe(false);
    expect(
      alphaShowInRemoteFromValues({
        alphaShowInRemoteEnvironments: "true",
      }),
    ).toBe(false);
  });

  it("allows remote environments only when explicitly enabled", () => {
    expect(
      alphaShowInRemoteFromValues({
        alphaShowInRemoteEnvironments: true,
      }),
    ).toBe(true);
  });
});
