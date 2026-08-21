/**
 * 本文件测试 AI 模型收藏和最近使用列表的更新规则。
 * 锁定去重、顺序、数量上限、无操作优化及持久化失败传播。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const prefsMock = vi.hoisted(() => ({
  favoriteModelIds: [] as string[],
  recentModelIds: [] as string[],
}));

const storeMock = vi.hoisted(() => ({
  setFavoriteModelIds: vi.fn(),
  setRecentModelIds: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      favoriteModelIds: prefsMock.favoriteModelIds,
      recentModelIds: prefsMock.recentModelIds,
    }),
  },
}));

vi.mock("@/modules/settings/store", () => storeMock);

import { pushRecentModel, toggleFavoriteModel } from "./modelPrefs";

beforeEach(() => {
  prefsMock.favoriteModelIds = [];
  prefsMock.recentModelIds = [];
  storeMock.setFavoriteModelIds.mockReset();
  storeMock.setRecentModelIds.mockReset();
});

describe("toggleFavoriteModel", () => {
  it("切换收藏标识的存在状态", async () => {
    prefsMock.favoriteModelIds = ["a"];
    await toggleFavoriteModel("b");
    expect(storeMock.setFavoriteModelIds).toHaveBeenCalledWith(["a", "b"]);

    prefsMock.favoriteModelIds = ["a", "b"];
    await toggleFavoriteModel("a");
    expect(storeMock.setFavoriteModelIds).toHaveBeenLastCalledWith(["b"]);
  });

  it("传播收藏写入失败", async () => {
    storeMock.setFavoriteModelIds.mockRejectedValueOnce(new Error("ipc down"));
    await expect(toggleFavoriteModel("a")).rejects.toThrow("ipc down");
  });
});

describe("pushRecentModel", () => {
  it("新增标识并将已有标识移动到最前", async () => {
    await pushRecentModel("a");
    expect(storeMock.setRecentModelIds).toHaveBeenCalledWith(["a"]);

    prefsMock.recentModelIds = ["a", "b", "c"];
    await pushRecentModel("b");
    expect(storeMock.setRecentModelIds).toHaveBeenLastCalledWith([
      "b",
      "a",
      "c",
    ]);
  });

  it("先去重再将列表限制为五项", async () => {
    prefsMock.recentModelIds = ["a", "b", "c", "d", "e"];
    await pushRecentModel("c");
    expect(storeMock.setRecentModelIds).toHaveBeenLastCalledWith([
      "c",
      "a",
      "b",
      "d",
      "e",
    ]);

    await pushRecentModel("x");
    expect(storeMock.setRecentModelIds).toHaveBeenLastCalledWith([
      "x",
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("标识已位于最前时不写入", async () => {
    prefsMock.recentModelIds = ["a", "b"];
    await pushRecentModel("a");
    expect(storeMock.setRecentModelIds).not.toHaveBeenCalled();
  });

  it("传播最近使用列表写入失败", async () => {
    storeMock.setRecentModelIds.mockRejectedValueOnce(new Error("ipc down"));
    await expect(pushRecentModel("a")).rejects.toThrow("ipc down");
  });
});
