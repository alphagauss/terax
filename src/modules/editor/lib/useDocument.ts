import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getSharedDocumentModel } from "./documentModel";

export { FORCE_READ_LIMIT } from "./documentModel";

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
};

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
