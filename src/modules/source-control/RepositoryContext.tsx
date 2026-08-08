/**
 * 本文件向工作区子树提供唯一的只读 Git 仓库快照。
 * 派生视图只能读取 repo、status 与 revision，不获得仓库操作方法。
 */

import { createContext, type ReactNode, useContext, useMemo } from "react";
import type { RepositoryController } from "./useRepositoryController";

/** 派生视图可观察的最小仓库状态。 */
type RepositorySnapshot = Pick<
  RepositoryController,
  "repo" | "status" | "revision"
>;

const RepositoryContext = createContext<RepositorySnapshot | null>(null);

/** 在工作区根部提供唯一的只读 Git 仓库快照。 */
export function RepositoryProvider({
  controller,
  children,
}: {
  controller: RepositoryController;
  children: ReactNode;
}) {
  const snapshot = useMemo<RepositorySnapshot>(
    () => ({
      repo: controller.repo,
      status: controller.status,
      revision: controller.revision,
    }),
    [controller.repo, controller.revision, controller.status],
  );
  return (
    <RepositoryContext.Provider value={snapshot}>
      {children}
    </RepositoryContext.Provider>
  );
}

/** 读取工作区唯一的只读 Git 仓库快照。 */
export function useRepositorySnapshot(): RepositorySnapshot {
  const snapshot = useContext(RepositoryContext);
  if (!snapshot) {
    throw new Error("RepositoryProvider is missing");
  }
  return snapshot;
}
