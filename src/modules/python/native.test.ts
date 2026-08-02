/**
 * 本文件测试 Python 解释器原生命令封装的 IPC 参数。
 * 锁定项目根目录、Workspace 环境与明确解释器路径不会在边界处丢失。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPythonInterpreters, probePythonInterpreter } from "./native";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("Python native commands", () => {
  beforeEach(() => invoke.mockReset());

  it("passes the project root and Workspace to discovery", async () => {
    invoke.mockResolvedValueOnce([]);
    const workspace = { kind: "wsl", distro: "Ubuntu" } as const;

    await listPythonInterpreters("/work/project", workspace);

    expect(invoke).toHaveBeenCalledWith("python_list_interpreters", {
      root: "/work/project",
      workspace,
    });
  });

  it("passes an explicit interpreter path to probing", async () => {
    invoke.mockResolvedValueOnce({ path: "/usr/bin/python3" });
    const workspace = { kind: "ssh", profileId: "server" } as const;

    await probePythonInterpreter("/usr/bin/python3", workspace);

    expect(invoke).toHaveBeenCalledWith("python_probe_interpreter", {
      path: "/usr/bin/python3",
      workspace,
    });
  });
});
