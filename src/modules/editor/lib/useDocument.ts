/**
 * 本文件将共享文档模型连接到 React。
 *
 * 同一路径的多个视图共享读取、缓冲区和保存状态，调用方不得另建独立副本。
 */

import { documentPathIdentity } from "@/lib/pathIdentity";
import {
  subscribeActiveFile,
  subscribeWorkspaceResume,
} from "@/modules/filesystem";
import { useRepositorySnapshot } from "@/modules/source-control/RepositoryContext";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getSharedDocumentModel } from "./documentModel";

export { FORCE_READ_LIMIT } from "./documentModel";

type Options = {
  path: string;
  active?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

/** 订阅指定路径的共享文档，登记前后台轮询优先级并暴露稳定的编辑、保存和重载动作。 */
export function useDocument({ path, active = true, onDirtyChange }: Options) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const repository = useRepositorySnapshot();
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
  const remotePollingOwnerRef = useRef(Symbol(path));
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(snapshot.dirty);
  }, [snapshot.dirty]);

  useEffect(() => {
    const owner = remotePollingOwnerRef.current;
    model.setRemotePollingActive(owner, active);
    if (!active) return () => model.clearRemotePollingOwner(owner);

    const revalidate = () => model.revalidateAfterActivation();
    const unsubscribeFile = subscribeActiveFile(workspace, path, revalidate);
    const unsubscribeResume = subscribeWorkspaceResume(revalidate);
    return () => {
      unsubscribeFile();
      unsubscribeResume();
      model.clearRemotePollingOwner(owner);
    };
  }, [active, model, path, workspace]);

  useEffect(() => {
    if (
      snapshot.doc.status !== "ready" ||
      !repository.repo ||
      !repository.status
    ) {
      return;
    }
    const fileIdentity = documentPathIdentity(workspace, path);
    const rootIdentity = documentPathIdentity(
      workspace,
      repository.repo.repoRoot,
    ).replace(/\/$/, "");
    if (
      fileIdentity === rootIdentity ||
      fileIdentity.startsWith(`${rootIdentity}/`)
    ) {
      model.syncGitBaseline(
        repository.repo.repoRoot,
        repository.status.headSha,
      );
    }
  }, [
    model,
    path,
    repository.repo,
    repository.status,
    snapshot.doc.status,
    workspace,
  ]);

  return {
    doc: snapshot.doc,
    dirty: snapshot.dirty,
    baselineContent: snapshot.baselineContent,
    gitBaseline: snapshot.gitBaseline,
    onChange: model.onChange,
    save: model.save,
    reload: model.reload,
    checkForChanges: model.checkForChanges,
    adoptFormattedDiskText: model.adoptFormattedDiskText,
    openAnyway: model.openAnyway,
  };
}

export type EditorDocument = ReturnType<typeof useDocument>;
