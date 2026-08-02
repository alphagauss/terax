/**
 * 本文件持久化每个 Workspace 项目根目录选中的 Python 解释器。
 * 选择以运行环境和规范化根路径共同隔离，并限制历史条目数量。
 */

import { documentResourceKey } from "@/lib/pathIdentity";
import type { PythonInterpreter } from "@/modules/python/native";
import type { WorkspaceEnv } from "@/modules/workspace";
import {
  getWorkspaceValue,
  setWorkspaceValue,
} from "@/modules/workspace-process";
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "python:interpreterSelections";
const MAX_SELECTIONS = 32;

type StoredSelection = {
  interpreter: PythonInterpreter;
  updatedAt: number;
};

type StoredSelections = Record<string, StoredSelection>;

let selections: StoredSelections | null = null;
const listeners = new Set<() => void>();

function readSelections(): StoredSelections {
  if (selections) return selections;
  const stored = getWorkspaceValue<StoredSelections>(STORAGE_KEY);
  selections = stored && typeof stored === "object" ? stored : {};
  return selections;
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 生成项目级解释器选择键，避免 Local、WSL 与 SSH 之间相互复用路径。 */
function pythonSelectionKey(root: string, workspace: WorkspaceEnv): string {
  return documentResourceKey(workspace, root);
}

/** 读取指定项目当前选中的解释器。 */
export function getPythonInterpreterSelection(
  root: string | null,
  workspace: WorkspaceEnv,
): PythonInterpreter | null {
  if (!root) return null;
  return (
    readSelections()[pythonSelectionKey(root, workspace)]?.interpreter ?? null
  );
}

/** 保存项目解释器，并淘汰最久未更新的历史项目记录。 */
export async function setPythonInterpreterSelection(
  root: string,
  workspace: WorkspaceEnv,
  interpreter: PythonInterpreter,
): Promise<void> {
  const previous = readSelections();
  const key = pythonSelectionKey(root, workspace);
  const next: StoredSelections = {
    ...previous,
    [key]: { interpreter, updatedAt: Date.now() },
  };
  const entries = Object.entries(next).sort(
    ([, left], [, right]) => right.updatedAt - left.updatedAt,
  );
  const persisted = Object.fromEntries(entries.slice(0, MAX_SELECTIONS));
  await setWorkspaceValue(STORAGE_KEY, persisted);
  selections = persisted;
  emitChange();
}

/** 订阅当前项目的解释器选择，供状态栏与选择对话框共享即时状态。 */
export function usePythonInterpreterSelection(
  root: string | null,
  workspace: WorkspaceEnv,
): PythonInterpreter | null {
  return useSyncExternalStore(
    subscribe,
    () => getPythonInterpreterSelection(root, workspace),
    () => getPythonInterpreterSelection(root, workspace),
  );
}
