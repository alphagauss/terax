/**
 * 本文件测试 Python 文件运行协调 Hook。
 * 锁定解释器复用、项目运行终端的最新请求等待，以及选择失败与运行失败的边界。
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
  toastShow: vi.fn(),
  toastDismiss: vi.fn(),
  whenSessionReady: vi.fn(),
  executeCommand: vi.fn(),
  terminalStates: new Map<
    number,
    "unknown" | "idle" | "running" | "unavailable"
  >(),
  terminalListeners: new Map<number, Set<() => void>>(),
  onTerminalSubscribe: vi.fn(),
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
  executeCommandInSession: mocks.executeCommand,
  terminalCommandState: (terminalId: number) =>
    mocks.terminalStates.get(terminalId) ?? "unavailable",
  subscribeTerminalCommandState: (terminalId: number, listener: () => void) => {
    const listeners = mocks.terminalListeners.get(terminalId) ?? new Set();
    listeners.add(listener);
    mocks.terminalListeners.set(terminalId, listeners);
    mocks.onTerminalSubscribe(terminalId);
    return () => listeners.delete(listener);
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toastShow, {
    error: mocks.toastError,
    dismiss: mocks.toastDismiss,
  }),
}));
vi.mock("@/lib/errors", () => ({ reportError: mocks.toastError }));

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
type RunnerOptions = Parameters<typeof usePythonFileRunner>[0];

/** 创建最小 Hook 宿主，并允许测试只覆盖当前场景相关的依赖。 */
async function renderRunner(overrides: Partial<RunnerOptions> = {}) {
  const tabsRef =
    overrides.tabsRef ?? ({ current: [] } as MutableRefObject<Tab[]>);
  const editorRefs =
    overrides.editorRefs ??
    ({
      current: new Map<number, EditorPaneHandle>(),
    } as MutableRefObject<Map<number, EditorPaneHandle>>);
  const options: RunnerOptions = {
    workspace: { kind: "local" },
    explorerRoot: "C:/project",
    activeSpaceId: "default",
    tabsRef,
    editorRefs,
    ensureWorkspaceReady: vi.fn().mockResolvedValue("C:/Users/test"),
    newRunTab: vi.fn().mockReturnValue(7),
    activateTab: vi.fn(),
    updateTabTitle: vi.fn(),
    ...overrides,
  };
  let runner!: ReturnType<typeof usePythonFileRunner>;
  const Harness = () => {
    runner = usePythonFileRunner(options);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  return { runner, getRunner: () => runner, root, tabsRef, options };
}

/** 让 Mock 终端在创建后空闲，并在提交命令时立即进入忙碌状态。 */
function mockTrackedTerminalState(): void {
  mocks.whenSessionReady.mockImplementation(async (terminalId: number) => {
    mocks.terminalStates.set(terminalId, "idle");
  });
  mocks.executeCommand.mockImplementation((terminalId: number) => {
    mocks.terminalStates.set(terminalId, "running");
    return true;
  });
}

/** 向测试 Workbench 添加终端标签。 */
function addTerminalTab(
  tabsRef: MutableRefObject<Tab[]>,
  id: number,
  spaceId = "default",
): void {
  tabsRef.current.push({ id, kind: "terminal", spaceId, title: "python" });
}

describe("usePythonFileRunner", () => {
  beforeEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    mocks.selection = interpreter;
    mocks.setSelection.mockReset().mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    mocks.toastShow.mockReset();
    mocks.toastDismiss.mockReset();
    mocks.whenSessionReady.mockReset().mockResolvedValue(undefined);
    mocks.executeCommand.mockReset().mockReturnValue(true);
    mocks.terminalStates.clear();
    mocks.terminalListeners.clear();
    mocks.onTerminalSubscribe.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    reactTestEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.restoreAllMocks();
  });

  it("runs an existing selection without rewriting it", async () => {
    const newRunTab = vi.fn().mockReturnValue(7);
    const { runner, root } = await renderRunner({ newRunTab });

    await act(async () => runner.runFile("C:/project/main.py", "C:/project"));

    expect(mocks.setSelection).not.toHaveBeenCalled();
    expect(newRunTab).toHaveBeenCalledWith(
      "C:/project",
      "python · main.py",
      "default",
      undefined,
    );
    expect(mocks.executeCommand).toHaveBeenCalledWith(
      7,
      "& 'C:/Python/python.exe' 'C:/project/main.py'",
    );
    act(() => root.unmount());
  });

  it("keeps only the latest request until the managed terminal is idle", async () => {
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    const newRunTab = vi.fn().mockImplementation(() => {
      addTerminalTab(tabsRef, 7);
      return 7;
    });
    mockTrackedTerminalState();
    const { runner, root } = await renderRunner({ tabsRef, newRunTab });

    await act(async () => runner.runFile("C:/project/first.py", "C:/project"));
    await act(async () => {
      await Promise.all([
        runner.runFile("C:/project/second.py", "C:/project"),
        runner.runFile("C:/project/latest.py", "C:/project"),
      ]);
    });

    expect(newRunTab).toHaveBeenCalledOnce();
    expect(mocks.toastShow).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenCalledTimes(1);

    mocks.terminalStates.set(7, "idle");
    await act(async () => {
      for (const listener of mocks.terminalListeners.get(7) ?? []) listener();
      await Promise.resolve();
    });

    expect(mocks.toastDismiss).toHaveBeenCalledOnce();
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      7,
      "& 'C:/Python/python.exe' 'C:/project/latest.py'",
    );
    act(() => root.unmount());
  });

  it("rechecks state after subscribing so an idle transition is not lost", async () => {
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    const newRunTab = vi.fn().mockImplementation(() => {
      addTerminalTab(tabsRef, 7);
      return 7;
    });
    mockTrackedTerminalState();
    const { runner, root } = await renderRunner({ tabsRef, newRunTab });
    await act(async () => runner.runFile("C:/project/first.py", "C:/project"));
    mocks.onTerminalSubscribe.mockImplementation(() => {
      mocks.terminalStates.set(7, "idle");
    });

    await act(async () => {
      await runner.runFile("C:/project/next.py", "C:/project");
      await Promise.resolve();
    });

    expect(mocks.toastDismiss).toHaveBeenCalledOnce();
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      7,
      "& 'C:/Python/python.exe' 'C:/project/next.py'",
    );
    act(() => root.unmount());
  });

  it("does not reuse a managed terminal moved to another Space", async () => {
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    let nextTerminalId = 6;
    const newRunTab = vi
      .fn()
      .mockImplementation(
        (
          _cwd: string | undefined,
          _title: string,
          spaceId: string | undefined,
        ) => {
          const id = ++nextTerminalId;
          addTerminalTab(tabsRef, id, spaceId);
          return id;
        },
      );
    mockTrackedTerminalState();
    const { runner, root } = await renderRunner({
      activeSpaceId: "space-a",
      tabsRef,
      newRunTab,
    });

    await act(async () => runner.runFile("C:/project/first.py", "C:/project"));
    tabsRef.current = tabsRef.current.map((tab) =>
      tab.id === 7 ? { ...tab, spaceId: "space-b" } : tab,
    );
    await act(async () => runner.runFile("C:/project/second.py", "C:/project"));

    expect(newRunTab).toHaveBeenCalledTimes(2);
    expect(newRunTab).toHaveBeenLastCalledWith(
      "C:/project",
      "python · second.py",
      "space-a",
      undefined,
    );
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      8,
      "& 'C:/Python/python.exe' 'C:/project/second.py'",
    );
    act(() => root.unmount());
  });

  it("keeps separate managed terminals for the same root in different Spaces", async () => {
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    let nextTerminalId = 6;
    const newRunTab = vi
      .fn()
      .mockImplementation(
        (
          _cwd: string | undefined,
          _title: string,
          spaceId: string | undefined,
        ) => {
          const id = ++nextTerminalId;
          addTerminalTab(tabsRef, id, spaceId);
          return id;
        },
      );
    mockTrackedTerminalState();
    const { runner, root } = await renderRunner({ tabsRef, newRunTab });

    await act(async () => runner.runFile("C:/project/a.py", "C:/project"));
    await act(async () =>
      runner.runFile("C:/project/b.py", "C:/project", undefined, "space-b"),
    );
    mocks.terminalStates.set(7, "idle");
    await act(async () => runner.runFile("C:/project/c.py", "C:/project"));

    expect(newRunTab).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      7,
      "& 'C:/Python/python.exe' 'C:/project/c.py'",
    );
    act(() => root.unmount());
  });

  it("cancels waiting or runs the claimed request in a new terminal", async () => {
    const tabsRef = { current: [] } as MutableRefObject<Tab[]>;
    let nextTerminalId = 6;
    const newRunTab = vi.fn().mockImplementation(() => {
      const id = ++nextTerminalId;
      addTerminalTab(tabsRef, id);
      return id;
    });
    mockTrackedTerminalState();
    const { runner, root } = await renderRunner({ tabsRef, newRunTab });

    await act(async () => runner.runFile("C:/project/first.py", "C:/project"));
    await act(async () => runner.runFile("C:/project/cancel.py", "C:/project"));
    const cancelToast = mocks.toastShow.mock.calls[
      mocks.toastShow.mock.calls.length - 1
    ][1] as {
      cancel: { onClick: () => void };
    };
    act(() => cancelToast.cancel.onClick());

    mocks.terminalStates.set(7, "running");
    await act(async () =>
      runner.runFile("C:/project/parallel.py", "C:/project"),
    );
    const parallelToast = mocks.toastShow.mock.calls[
      mocks.toastShow.mock.calls.length - 1
    ][1] as {
      action: { onClick: () => void };
    };
    await act(async () => {
      parallelToast.action.onClick();
      await Promise.resolve();
    });

    expect(mocks.toastDismiss).toHaveBeenCalledTimes(2);
    expect(newRunTab).toHaveBeenCalledTimes(2);
    expect(mocks.executeCommand).toHaveBeenLastCalledWith(
      8,
      "& 'C:/Python/python.exe' 'C:/project/parallel.py'",
    );
    act(() => root.unmount());
  });

  it("does not report a post-selection run failure as a selection failure", async () => {
    mocks.selection = null;
    mocks.setSelection.mockImplementation(
      async (_root, _workspace, selected) => {
        mocks.selection = selected;
      },
    );
    const ensureWorkspaceReady = vi
      .fn()
      .mockRejectedValue(new Error("workspace failed"));
    const { runner, getRunner, root } = await renderRunner({
      ensureWorkspaceReady,
    });
    await act(async () => runner.runFile("C:/project/main.py", "C:/project"));

    await act(async () => {
      await expect(
        getRunner().selectInterpreter(interpreter),
      ).resolves.toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.setSelection).toHaveBeenCalledOnce();
    expect(mocks.toastError).toHaveBeenCalledWith("runFailed", {
      error: expect.objectContaining({ message: "workspace failed" }),
    });
    act(() => root.unmount());
  });
});
