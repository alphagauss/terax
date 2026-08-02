/**
 * 本文件测试 Python 文件运行协调 Hook。
 * 锁定已选择解释器不会在每次运行时重复探测或持久化，并区分选择失败与运行失败。
 */

// @vitest-environment happy-dom

import type { EditorPaneHandle } from "@/modules/editor";
import type { PythonInterpreter } from "@/modules/python/native";
import { usePythonFileRunner } from "@/modules/python/usePythonFileRunner";
import type { Tab } from "@/modules/workbench";
import { act, createElement, type MutableRefObject } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selection: null as PythonInterpreter | null,
  setSelection: vi.fn(),
  toastError: vi.fn(),
  whenSessionReady: vi.fn(),
  writeToSession: vi.fn(),
}));

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

vi.mock("@/modules/python/selection", () => ({
  getPythonInterpreterSelection: () => mocks.selection,
  setPythonInterpreterSelection: mocks.setSelection,
  usePythonInterpreterSelection: () => mocks.selection,
}));

vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ terminalShell: "pwsh.exe" }),
  },
}));

vi.mock("@/modules/terminal", () => ({
  whenSessionReady: mocks.whenSessionReady,
  writeToSession: mocks.writeToSession,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: { error: mocks.toastError },
}));

const interpreter: PythonInterpreter = {
  path: "C:/Python/python.exe",
  environmentRoot: "C:/Python",
  version: "3.13.4",
  name: "Python 3.13",
  kind: "system",
  source: "path",
};

const reactTestEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT: boolean;
};

describe("usePythonFileRunner", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.selection = interpreter;
    mocks.setSelection.mockReset().mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    mocks.whenSessionReady.mockReset().mockResolvedValue(undefined);
    mocks.writeToSession.mockReset().mockReturnValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  it("runs an existing selection without rewriting it", async () => {
    const ensureWorkspaceReady = vi.fn().mockResolvedValue("C:/Users/test");
    const newRunTab = vi.fn().mockReturnValue({ tabId: 7, leafId: 8 });
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    const editorRefs = {
      current: new Map<number, EditorPaneHandle>(),
    } as MutableRefObject<Map<number, EditorPaneHandle>>;
    let runner!: ReturnType<typeof usePythonFileRunner>;
    const Harness = () => {
      runner = usePythonFileRunner({
        workspace: { kind: "local" },
        explorerRoot: "C:/project",
        tabsRef,
        editorRefs,
        ensureWorkspaceReady,
        newRunTab,
      });
      return null;
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));

    await act(async () => runner.runFile("C:/project/main.py", "C:/project"));

    expect(mocks.setSelection).not.toHaveBeenCalled();
    expect(newRunTab).toHaveBeenCalledWith(
      "C:/project",
      "python · main.py",
      undefined,
    );
    expect(mocks.writeToSession).toHaveBeenCalledWith(
      8,
      "& 'C:/Python/python.exe' 'C:/project/main.py'\r",
    );
    act(() => root.unmount());
  });

  it("does not report a post-selection run failure as a selection failure", async () => {
    mocks.selection = null;
    const ensureWorkspaceReady = vi
      .fn()
      .mockRejectedValue(new Error("workspace failed"));
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    const editorRefs = {
      current: new Map<number, EditorPaneHandle>(),
    } as MutableRefObject<Map<number, EditorPaneHandle>>;
    let runner!: ReturnType<typeof usePythonFileRunner>;
    const Harness = () => {
      runner = usePythonFileRunner({
        workspace: { kind: "local" },
        explorerRoot: "C:/project",
        tabsRef,
        editorRefs,
        ensureWorkspaceReady,
        newRunTab: vi.fn().mockReturnValue({ tabId: 7, leafId: 8 }),
      });
      return null;
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
    await act(async () => runner.runFile("C:/project/main.py", "C:/project"));

    await expect(
      runner.selectInterpreter(interpreter),
    ).resolves.toBeUndefined();
    await act(async () => Promise.resolve());

    expect(mocks.setSelection).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith("runFailed", {
      description: "Error: workspace failed",
    });
    act(() => root.unmount());
  });
});
