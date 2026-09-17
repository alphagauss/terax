/**
 * 本文件验证桌面 AI 最近选择只精确写入对应共享设置键。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const sharedStore = vi.hoisted(() => ({
  mutate: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/sharedStore", () => ({
  mutateSharedStore: sharedStore.mutate,
  setSharedStoreKey: sharedStore.set,
}));

import {
  setDesktopModelSelection,
  setDesktopPermissionMode,
} from "@/modules/settings/store";

describe("desktop AI preferences", () => {
  beforeEach(() => {
    sharedStore.mutate.mockReset();
    sharedStore.set.mockReset();
  });

  it("persists the complete model identity and request parameters atomically", async () => {
    const model = { providerId: "custom:provider", modelId: "coder-v2" };

    await setDesktopModelSelection(model, { reasoning: "high" });

    expect(sharedStore.mutate).toHaveBeenCalledWith("settings", [
      { kind: "set", key: "desktopModel", value: model },
      {
        kind: "set",
        key: "desktopModelParameterSelections",
        value: { reasoning: "high" },
      },
    ]);
  });

  it("persists the desktop permission independently from Channel", async () => {
    await setDesktopPermissionMode("full-access");

    expect(sharedStore.set).toHaveBeenCalledWith(
      "settings",
      "desktopPermissionMode",
      "full-access",
    );
  });
});
