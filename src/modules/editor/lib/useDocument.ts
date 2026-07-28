/**
 * 本文件将共享文档模型连接到 React。
 *
 * 同一路径的多个视图共享读取、缓冲区和保存状态，调用方不得另建独立副本。
 */

import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getSharedDocumentModel } from "./documentModel";

export { FORCE_READ_LIMIT } from "./documentModel";

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

/** 订阅指定路径的共享文档，并暴露稳定的编辑、保存和重载动作。 */
export function useDocument({ path, onDirtyChange }: Options) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const model = useMemo(
    () => getSharedDocumentModel(workspace, path),
    [path, workspace],
  );
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  );

  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(snapshot.dirty);
  }, [snapshot.dirty]);

  return {
    doc: snapshot.doc,
    dirty: snapshot.dirty,
    baselineContent: snapshot.baselineContent,
    onChange: model.onChange,
    save: model.save,
    reload: model.reload,
    adoptDiskText: model.adoptDiskText,
    openAnyway: model.openAnyway,
  };
}

export type EditorDocument = ReturnType<typeof useDocument>;
