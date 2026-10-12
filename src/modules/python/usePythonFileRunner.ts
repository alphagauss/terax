/**
 * 本文件协调项目级 Python 解释器选择与文件运行流程。
 * 每个项目根目录和 Space 按需复用运行终端，忙碌时只保留最新待运行请求。
 */

import { documentResourceKey } from "@/lib/pathIdentity";
import type { EditorPaneHandle } from "@/modules/editor";
import type { PythonInterpreter } from "@/modules/python/native";
import {
  isPythonFile,
  pythonFileName,
  pythonParentDirectory,
} from "@/modules/python/path";
import { buildPythonRunCommand } from "@/modules/python/runCommand";
import {
  getPythonInterpreterSelection,
  setPythonInterpreterSelection,
  usePythonInterpreterSelection,
} from "@/modules/python/selection";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  executeCommandInSession,
  subscribeTerminalCommandState,
  terminalCommandState,
  whenSessionReady,
} from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";

type PickerRequest =
  | { kind: "select"; root: string }
  | {
      kind: "run";
      root: string;
      path: string;
      spaceId: string;
      groupId?: number;
    };

type Options = {
  workspace: WorkspaceEnv;
  explorerRoot: string | null;
  activeSpaceId: string;
  tabsRef: MutableRefObject<Tab[]>;
  editorRefs: MutableRefObject<Map<number, EditorPaneHandle>>;
  ensureWorkspaceReady: () => Promise<string | null>;
  newRunTab: (
    cwd: string | undefined,
    title: string,
    spaceId?: string,
    groupId?: number,
  ) => number;
  activateTab: (tabId: number) => void;
  updateTabTitle: (tabId: number, title: string) => void;
};

type RunRequest = {
  id: number;
  key: string;
  path: string;
  root: string;
  spaceId: string;
  groupId?: number;
  interpreter: PythonInterpreter;
};

type PendingRun = {
  request: RunRequest;
  terminalId: number;
  unsubscribe: () => void;
};

function runTerminalKey(
  root: string,
  spaceId: string,
  workspace: WorkspaceEnv,
): string {
  return `${documentResourceKey(workspace, root)}\0${spaceId}`;
}

/**
 * 提供 Python 文件运行入口、状态栏选择状态和受控选择器参数。
 * 所有解释器选择按 Workspace 环境与项目根目录隔离。
 */
export function usePythonFileRunner({
  workspace,
  explorerRoot,
  activeSpaceId,
  tabsRef,
  editorRefs,
  ensureWorkspaceReady,
  newRunTab,
  activateTab,
  updateTabTitle,
}: Options) {
  const { t } = useTranslation("python");
  const interpreter = usePythonInterpreterSelection(explorerRoot, workspace);
  const [pickerRequest, setPickerRequest] = useState<PickerRequest | null>(
    null,
  );
  const runTerminals = useRef(new Map<string, number>());
  const pendingRuns = useRef(new Map<string, PendingRun>());
  const operations = useRef(new Map<string, Promise<void>>());
  const nextRequestId = useRef(1);
  const handlePendingStateRef = useRef<(key: string) => void>(() => {});

  /** 按项目运行键串行修改终端，避免保存和 PTY 启动期间的重复创建。 */
  const enqueue = useCallback(
    (key: string, operation: () => Promise<void>) => {
      const previous = operations.current.get(key) ?? Promise.resolve();
      const current = previous.then(operation).catch((error) => {
        console.warn("[python] failed to run file", error);
        reportError(t("runFailed"), { error });
      });
      operations.current.set(key, current);
      void current.then(() => {
        if (operations.current.get(key) === current) {
          operations.current.delete(key);
        }
      });
      return current;
    },
    [t],
  );

  /** 保存同一路径的共享编辑缓冲区，确保运行读取最新磁盘内容。 */
  const saveBeforeRun = useCallback(
    async (path: string): Promise<boolean> => {
      const resourceKey = documentResourceKey(workspace, path);
      const dirtyTab = tabsRef.current.find(
        (tab) =>
          (tab.kind === "editor" || tab.kind === "markdown") &&
          tab.dirty &&
          documentResourceKey(workspace, tab.path) === resourceKey,
      );
      if (!dirtyTab) return true;
      const editor = editorRefs.current.get(dirtyTab.id);
      if (!editor) {
        reportError(t("runFailed"), { description: t("saveRequired") });
        return false;
      }
      return editor.save();
    },
    [editorRefs, t, tabsRef, workspace],
  );

  /** 保存最新内容并确保当前 Workspace 的原生运行时可用。 */
  const prepareRun = useCallback(
    async (request: RunRequest): Promise<boolean> => {
      if (!(await saveBeforeRun(request.path))) return false;
      if (await ensureWorkspaceReady()) return true;
      reportError(t("runFailed"));
      return false;
    },
    [ensureWorkspaceReady, saveBeforeRun, t],
  );

  /** 构造并提交 Python 命令，提交前同步更新终端忙碌状态。 */
  const submitRun = useCallback(
    (terminalId: number, request: RunRequest): boolean => {
      const command = buildPythonRunCommand(
        request.interpreter.path,
        request.path,
        workspace,
        usePreferencesStore.getState().terminalShell,
      );
      return executeCommandInSession(terminalId, command);
    },
    [workspace],
  );

  /** 在已有项目运行终端中执行请求。 */
  const executeInExistingTerminal = useCallback(
    (terminalId: number, request: RunRequest): void => {
      const title = `python · ${pythonFileName(request.path)}`;
      updateTabTitle(terminalId, title);
      activateTab(terminalId);
      if (!submitRun(terminalId, request)) reportError(t("runFailed"));
    },
    [activateTab, submitRun, t, updateTabTitle],
  );

  /** 创建运行终端并执行请求；并行终端不会替换项目的复用关联。 */
  const executeInNewTerminal = useCallback(
    async (request: RunRequest, managed: boolean): Promise<void> => {
      const tabId = newRunTab(
        request.root,
        `python · ${pythonFileName(request.path)}`,
        request.spaceId,
        request.groupId,
      );
      if (managed) runTerminals.current.set(request.key, tabId);
      await whenSessionReady(tabId);
      if (submitRun(tabId, request)) return;
      if (managed && runTerminals.current.get(request.key) === tabId) {
        runTerminals.current.delete(request.key);
      }
      reportError(t("runFailed"));
    },
    [newRunTab, submitRun, t],
  );

  /** 原子领取待运行请求，并同步结束其 Toast 与状态订阅。 */
  const takePending = useCallback(
    (key: string, requestId?: number): RunRequest | null => {
      const pending = pendingRuns.current.get(key);
      if (
        !pending ||
        (requestId !== undefined && pending.request.id !== requestId)
      ) {
        return null;
      }
      pendingRuns.current.delete(key);
      pending.unsubscribe();
      toast.dismiss(`python-run-waiting:${key}`);
      return pending.request;
    },
    [],
  );

  /** 展示与最新请求绑定的持续通知，两个操作都先领取请求以避免重复执行。 */
  const showWaitingToast = useCallback(
    (request: RunRequest) => {
      toast(t("waitingTitle", { file: pythonFileName(request.path) }), {
        id: `python-run-waiting:${request.key}`,
        description: t("waitingDescription"),
        duration: Infinity,
        dismissible: false,
        closeButton: false,
        cancel: {
          label: t("cancelWaiting"),
          onClick: () => takePending(request.key, request.id),
        },
        action: {
          label: t("runInNewTerminal"),
          onClick: () => {
            const claimed = takePending(request.key, request.id);
            if (claimed) {
              void enqueue(request.key, async () => {
                if (await prepareRun(claimed)) {
                  await executeInNewTerminal(claimed, false);
                }
              });
            }
          },
        },
      });
    },
    [enqueue, executeInNewTerminal, prepareRun, t, takePending],
  );

  /** 为忙碌项目终端保存唯一的最新请求，并只注册一个状态监听器。 */
  const waitForTerminal = useCallback(
    (terminalId: number, request: RunRequest) => {
      const existing = pendingRuns.current.get(request.key);
      if (existing) {
        existing.request = request;
      } else {
        pendingRuns.current.set(request.key, {
          request,
          terminalId,
          unsubscribe: subscribeTerminalCommandState(terminalId, () =>
            handlePendingStateRef.current(request.key),
          ),
        });
      }
      showWaitingToast(request);
      // 订阅前后再次读取状态，避免进程恰在两者之间结束而永久等待。
      handlePendingStateRef.current(request.key);
    },
    [showWaitingToast],
  );

  /** 只返回仍位于原 Space 的项目运行终端，关闭或移动后的标签不再复用。 */
  const reusableTerminalId = useCallback(
    (request: RunRequest): number | null => {
      const terminalId = runTerminals.current.get(request.key);
      if (terminalId === undefined) return null;
      const reusable = tabsRef.current.some(
        (tab) =>
          tab.id === terminalId &&
          tab.kind === "terminal" &&
          tab.spaceId === request.spaceId,
      );
      if (reusable) return terminalId;
      runTerminals.current.delete(request.key);
      return null;
    },
    [tabsRef],
  );

  /** 复用项目终端；无法可靠判断状态的 Shell 安全回退到新终端。 */
  const execute = useCallback(
    async (request: RunRequest): Promise<void> => {
      const initialTerminalId = reusableTerminalId(request);
      if (
        initialTerminalId !== null &&
        terminalCommandState(initialTerminalId) === "running"
      ) {
        activateTab(initialTerminalId);
        waitForTerminal(initialTerminalId, request);
        return;
      }

      if (!(await prepareRun(request))) return;
      const terminalId = reusableTerminalId(request);
      if (terminalId === null) {
        await executeInNewTerminal(request, true);
        return;
      }

      const state = terminalCommandState(terminalId);
      if (state === "idle") {
        executeInExistingTerminal(terminalId, request);
      } else if (state === "running") {
        activateTab(terminalId);
        waitForTerminal(terminalId, request);
      } else if (state === "unavailable") {
        runTerminals.current.delete(request.key);
        await executeInNewTerminal(request, true);
      } else {
        await executeInNewTerminal(request, false);
      }
    },
    [
      activateTab,
      executeInExistingTerminal,
      executeInNewTerminal,
      prepareRun,
      reusableTerminalId,
      waitForTerminal,
    ],
  );

  handlePendingStateRef.current = (key) => {
    const pending = pendingRuns.current.get(key);
    if (!pending) return;
    const state = terminalCommandState(pending.terminalId);
    if (state === "idle") {
      const request = takePending(key);
      if (request) void enqueue(key, () => execute(request));
    } else if (state === "unavailable") {
      takePending(key);
    }
  };

  /** 使用项目已选择的解释器运行文件，未选择时先打开选择器。 */
  const runFile = useCallback(
    async (
      path: string,
      root: string,
      groupId?: number,
      spaceId = activeSpaceId,
    ): Promise<void> => {
      const selected = getPythonInterpreterSelection(root, workspace);
      if (!selected) {
        setPickerRequest({ kind: "run", path, root, spaceId, groupId });
        return;
      }
      const key = runTerminalKey(root, spaceId, workspace);
      const request: RunRequest = {
        id: nextRequestId.current++,
        key,
        path,
        root,
        spaceId,
        groupId,
        interpreter: selected,
      };
      const pending = pendingRuns.current.get(key);
      if (pending) {
        if (reusableTerminalId(request) === pending.terminalId) {
          waitForTerminal(pending.terminalId, request);
          return;
        }
        takePending(key);
      }
      await enqueue(key, () => execute(request));
    },
    [
      activeSpaceId,
      enqueue,
      execute,
      reusableTerminalId,
      takePending,
      waitForTerminal,
      workspace,
    ],
  );

  /** 从标签记录推导项目根目录，并触发与资源管理器一致的运行流程。 */
  const runTab = useCallback(
    (tabId: number, groupId: number) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "editor" || !isPythonFile(tab.path)) return;
      const root =
        tab.explorerRoot ?? explorerRoot ?? pythonParentDirectory(tab.path);
      if (root) void runFile(tab.path, root, groupId, tab.spaceId);
    },
    [explorerRoot, runFile, tabsRef],
  );

  /** 保存选择结果，并继续选择器打开前暂存的运行请求。 */
  const selectInterpreter = useCallback(
    async (selected: PythonInterpreter): Promise<void> => {
      if (!pickerRequest) return;
      await setPythonInterpreterSelection(
        pickerRequest.root,
        workspace,
        selected,
      );
      if (pickerRequest.kind === "run") {
        void runFile(
          pickerRequest.path,
          pickerRequest.root,
          pickerRequest.groupId,
          pickerRequest.spaceId,
        );
      }
    },
    [pickerRequest, runFile, workspace],
  );

  useEffect(
    () => () => {
      for (const [key, pending] of pendingRuns.current) {
        pending.unsubscribe();
        toast.dismiss(`python-run-waiting:${key}`);
      }
      pendingRuns.current.clear();
    },
    [],
  );

  return {
    interpreter,
    pickerRequest,
    selectedPath: pickerRequest
      ? (getPythonInterpreterSelection(pickerRequest.root, workspace)?.path ??
        null)
      : null,
    openSelector: () => {
      if (explorerRoot)
        setPickerRequest({ kind: "select", root: explorerRoot });
    },
    closeSelector: () => setPickerRequest(null),
    selectInterpreter,
    runFile,
    runTab,
  };
}
