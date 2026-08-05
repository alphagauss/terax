/**
 * 本文件测试项目级 Python 解释器选择的隔离与持久化。
 * 锁定不同 Workspace 环境和根目录不会共享解释器路径。
 */

import type { PythonInterpreter } from "@/modules/python/native";
import * as selection from "@/modules/python/selection";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceStore = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  set: vi.fn(async (key: string, value: unknown) => {
    workspaceStore.values.set(key, value);
  }),
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceValue: (key: string) => workspaceStore.values.get(key),
  setWorkspaceValue: workspaceStore.set,
}));

const interpreter: PythonInterpreter = {
  path: "/project/.venv/bin/python",
  environmentRoot: "/project/.venv",
  version: "3.13.4",
  name: ".venv",
  kind: "workspaceVirtualEnv",
  source: "workspace",
};

describe("Python interpreter selection", () => {
  beforeEach(() => {
    workspaceStore.values.clear();
    workspaceStore.set.mockReset().mockImplementation(async (key, value) => {
      workspaceStore.values.set(key, value);
    });
  });

  it("isolates selections by project root and environment", async () => {
    await selection.setPythonInterpreterSelection(
      "/project",
      { kind: "local" },
      interpreter,
    );

    expect(
      selection.getPythonInterpreterSelection("/project", { kind: "local" }),
    ).toEqual(interpreter);
    expect(
      selection.getPythonInterpreterSelection("/other", { kind: "local" }),
    ).toBeNull();
    expect(
      selection.getPythonInterpreterSelection("/project", {
        kind: "wsl",
        distro: "Ubuntu",
      }),
    ).toBeNull();
    expect(workspaceStore.set).toHaveBeenCalledOnce();
  });

  it("keeps the in-memory selection unchanged when persistence fails", async () => {
    const root = "/failed-project";
    const workspace = { kind: "local" } as const;
    workspaceStore.set.mockRejectedValueOnce(new Error("store failed"));

    await expect(
      selection.setPythonInterpreterSelection(root, workspace, interpreter),
    ).rejects.toThrow("store failed");

    expect(selection.getPythonInterpreterSelection(root, workspace)).toBeNull();
  });
});
