/**
 * 本文件测试 Workspace Store 的关闭前刷新屏障。
 *
 * 显式落盘必须等待所有已经发出的 Store 修改完成，避免自动保存防抖截断状态。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  set: vi.fn(),
  delete: vi.fn(),
  save: vi.fn(),
  entries: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    set = storeMocks.set;
    delete = storeMocks.delete;
    save = storeMocks.save;
    entries = storeMocks.entries;
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: storeMocks.invoke,
}));

import {
  flushWorkspaceStore,
  initializeWorkspaceProcess,
  setWorkspaceValue,
} from "./index";

describe("Workspace Store flush", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    storeMocks.entries.mockResolvedValue([]);
    storeMocks.save.mockResolvedValue(undefined);
    storeMocks.invoke.mockResolvedValue({
      schemaVersion: 3,
      id: "workspace-test",
      isPrimary: true,
      env: { kind: "local" },
      environmentKey: "local",
      launchDir: null,
      launchFiles: [],
      statePath: "workspace-test.json",
      windowStateFilename: "workspace-test-window.json",
      windowGeometry: null,
    });
    await initializeWorkspaceProcess();
  });

  it("等待在途修改完成后再显式写入磁盘", async () => {
    let releaseSet: (() => void) | undefined;
    storeMocks.set.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSet = resolve;
      }),
    );

    const setting = setWorkspaceValue("layout", { active: true });
    const flushing = flushWorkspaceStore();
    await Promise.resolve();
    expect(storeMocks.save).not.toHaveBeenCalled();

    releaseSet?.();
    await setting;
    await flushing;
    expect(storeMocks.save).toHaveBeenCalledOnce();
  });
});
