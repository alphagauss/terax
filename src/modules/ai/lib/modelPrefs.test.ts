/**
 * 本文件测试 AI 模型收藏、最近使用和模型身份替换规则。
 * 锁定去重、顺序、数量上限、空模型回退及持久化失败传播。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelRefForProvider } from "../config";

const ref = (modelId: string) => modelRefForProvider("openai", modelId);

const prefsMock = vi.hoisted(() => ({
  favoriteModels: [] as ReturnType<typeof modelRefForProvider>[],
  recentModels: [] as ReturnType<typeof modelRefForProvider>[],
}));

const storeMock = vi.hoisted(() => ({
  setFavoriteModels: vi.fn(),
  setRecentModels: vi.fn(),
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({
      favoriteModels: prefsMock.favoriteModels,
      recentModels: prefsMock.recentModels,
    }),
  },
}));

vi.mock("@/modules/settings/store", () => storeMock);

import {
  buildModelReferencePatch,
  pushRecentModel,
  toggleFavoriteModel,
} from "./modelPrefs";

beforeEach(() => {
  prefsMock.favoriteModels = [];
  prefsMock.recentModels = [];
  storeMock.setFavoriteModels.mockReset();
  storeMock.setRecentModels.mockReset();
});

describe("toggleFavoriteModel", () => {
  it("切换收藏标识的存在状态", async () => {
    prefsMock.favoriteModels = [ref("a")];
    await toggleFavoriteModel(ref("b"));
    expect(storeMock.setFavoriteModels).toHaveBeenCalledWith([
      ref("a"),
      ref("b"),
    ]);

    prefsMock.favoriteModels = [ref("a"), ref("b")];
    await toggleFavoriteModel(ref("a"));
    expect(storeMock.setFavoriteModels).toHaveBeenLastCalledWith([ref("b")]);
  });

  it("传播收藏写入失败", async () => {
    storeMock.setFavoriteModels.mockRejectedValueOnce(new Error("ipc down"));
    await expect(toggleFavoriteModel(ref("a"))).rejects.toThrow("ipc down");
  });
});

describe("pushRecentModel", () => {
  it("新增标识并将已有标识移动到最前", async () => {
    await pushRecentModel(ref("a"));
    expect(storeMock.setRecentModels).toHaveBeenCalledWith([ref("a")]);

    prefsMock.recentModels = [ref("a"), ref("b"), ref("c")];
    await pushRecentModel(ref("b"));
    expect(storeMock.setRecentModels).toHaveBeenLastCalledWith([
      ref("b"),
      ref("a"),
      ref("c"),
    ]);
  });

  it("先去重再将列表限制为五项", async () => {
    prefsMock.recentModels = [ref("a"), ref("b"), ref("c"), ref("d"), ref("e")];
    await pushRecentModel(ref("c"));
    expect(storeMock.setRecentModels).toHaveBeenLastCalledWith([
      ref("c"),
      ref("a"),
      ref("b"),
      ref("d"),
      ref("e"),
    ]);

    await pushRecentModel(ref("x"));
    expect(storeMock.setRecentModels).toHaveBeenLastCalledWith([
      ref("x"),
      ref("a"),
      ref("b"),
      ref("c"),
      ref("d"),
    ]);
  });

  it("标识已位于最前时不写入", async () => {
    prefsMock.recentModels = [ref("a"), ref("b")];
    await pushRecentModel(ref("a"));
    expect(storeMock.setRecentModels).not.toHaveBeenCalled();
  });

  it("传播最近使用列表写入失败", async () => {
    storeMock.setRecentModels.mockRejectedValueOnce(new Error("ipc down"));
    await expect(pushRecentModel(ref("a"))).rejects.toThrow("ipc down");
  });
});

describe("buildModelReferencePatch", () => {
  const oldModel = modelRefForProvider("ollama", "old-model");
  const newModel = modelRefForProvider("ollama", "new-model");
  const otherModel = ref("other-model");
  const state = {
    defaultModel: oldModel,
    modelUsages: {
      completion: { model: oldModel, parameterSelections: {} },
      subagent: { model: oldModel, parameterSelections: {} },
    },
    favoriteModels: [oldModel, newModel, otherModel],
    recentModels: [oldModel, otherModel, newModel],
  };

  it("默认项切换到替代模型并清理列表中的失效引用", () => {
    expect(
      buildModelReferencePatch(
        state,
        (model) => model.providerId === oldModel.providerId,
        newModel,
      ),
    ).toEqual({
      defaultModel: newModel,
      favoriteModels: [otherModel],
      recentModels: [otherModel],
    });
  });

  it("移除失效引用时清空没有替代项的默认值", () => {
    expect(
      buildModelReferencePatch(
        state,
        (model) => model.providerId === oldModel.providerId,
        null,
      ),
    ).toEqual({
      defaultModel: null,
      favoriteModels: [otherModel],
      recentModels: [otherModel],
    });
  });
});
