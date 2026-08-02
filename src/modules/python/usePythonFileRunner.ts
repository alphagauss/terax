/**
 * 本文件协调项目级 Python 解释器选择与文件运行流程。
 * 运行前保存共享编辑缓冲区，解释器只在选择时探测，终端创建仍由 Workbench 提供。
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
import { whenSessionReady, writeToSession } from "@/modules/terminal";
import type { Tab } from "@/modules/workbench";
import type { WorkspaceEnv } from "@/modules/workspace";
import { type MutableRefObject, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

type PickerRequest =
  | { kind: "select"; root: string }
  | { kind: "run"; root: string; path: string; groupId?: number };

type Options = {
  workspace: WorkspaceEnv;
  explorerRoot: string | null;
  tabsRef: MutableRefObject<Tab[]>;
  editorRefs: MutableRefObject<Map<number, EditorPaneHandle>>;
  ensureWorkspaceReady: () => Promise<string | null>;
  newRunTab: (
    cwd: string | undefined,
    title: string,
    groupId?: number,
  ) => { tabId: number; leafId: number };
};

/**
 * 提供 Python 文件运行入口、状态栏选择状态和受控选择器参数。
 * 所有解释器选择按 Workspace 环境与项目根目录隔离。
 */
export function usePythonFileRunner({
  workspace,
  explorerRoot,
  tabsRef,
  editorRefs,
  ensureWorkspaceReady,
  newRunTab,
}: Options) {
  const { t } = useTranslation("python");
  const interpreter = usePythonInterpreterSelection(explorerRoot, workspace);
  const [pickerRequest, setPickerRequest] = useState<PickerRequest | null>(
    null,
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
        toast.error(t("runFailed"), { description: t("saveRequired") });
        return false;
      }
      return editor.save();
    },
    [editorRefs, t, tabsRef, workspace],
  );

  /** 创建项目根目录终端标签，并以明确解释器执行文件。 */
  const execute = useCallback(
    async (
      path: string,
      root: string,
      selected: PythonInterpreter,
      groupId?: number,
    ): Promise<void> => {
      try {
        if (!(await saveBeforeRun(path))) return;
        if (!(await ensureWorkspaceReady())) {
          toast.error(t("runFailed"));
          return;
        }
        const { leafId } = newRunTab(
          root,
          `python · ${pythonFileName(path)}`,
          groupId,
        );
        const command = buildPythonRunCommand(
          selected.path,
          path,
          workspace,
          usePreferencesStore.getState().terminalShell,
        );
        await whenSessionReady(leafId);
        if (!writeToSession(leafId, `${command}\r`)) {
          toast.error(t("runFailed"));
        }
      } catch (error) {
        console.warn("[python] failed to run file", error);
        toast.error(t("runFailed"), { description: String(error) });
      }
    },
    [ensureWorkspaceReady, newRunTab, saveBeforeRun, t, workspace],
  );

  /** 使用项目已选择的解释器运行文件，未选择时先打开选择器。 */
  const runFile = useCallback(
    async (path: string, root: string, groupId?: number): Promise<void> => {
      const selected = getPythonInterpreterSelection(root, workspace);
      if (!selected) {
        setPickerRequest({ kind: "run", path, root, groupId });
        return;
      }
      await execute(path, root, selected, groupId);
    },
    [execute, workspace],
  );

  /** 从标签记录推导项目根目录，并触发与资源管理器一致的运行流程。 */
  const runTab = useCallback(
    (tabId: number, groupId: number) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "editor" || !isPythonFile(tab.path)) return;
      const root =
        tab.explorerRoot ?? explorerRoot ?? pythonParentDirectory(tab.path);
      if (root) void runFile(tab.path, root, groupId);
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
        void execute(
          pickerRequest.path,
          pickerRequest.root,
          selected,
          pickerRequest.groupId,
        );
      }
    },
    [execute, pickerRequest, workspace],
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
