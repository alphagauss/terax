/**
 * 本文件测试 Alpha 环境可见性设置的解析和共享配置边界。
 * 重点锁定缺失值保持 Local-only，并且读写统一使用 Alpha 前端共享 store。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSharedStore: vi.fn(),
  setSharedStoreKey: vi.fn(),
}));

vi.mock("@/lib/sharedStore", () => ({
  readSharedStore: mocks.readSharedStore,
  setSharedStoreKey: mocks.setSharedStoreKey,
  onSharedStoreChange: vi.fn(),
}));

import {
  alphaShowInRemoteFromValues,
  initializeAlphaPreferences,
  setAlphaShowInRemote,
} from "@/modules/alpha/preferences";

describe("Alpha visibility preferences", () => {
  beforeEach(() => {
    mocks.readSharedStore.mockResolvedValue({});
    mocks.setSharedStoreKey.mockResolvedValue(undefined);
    vi.clearAllMocks();
  });

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

  it("统一从 Alpha 共享 store 读取和写入前端设置", async () => {
    await initializeAlphaPreferences();
    await setAlphaShowInRemote(true);

    expect(mocks.readSharedStore).toHaveBeenCalledWith("alpha");
    expect(mocks.setSharedStoreKey).toHaveBeenCalledWith(
      "alpha",
      "alphaShowInRemoteEnvironments",
      true,
    );
  });
});
