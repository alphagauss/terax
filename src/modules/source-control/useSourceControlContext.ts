/** 源码管理侧栏与文件管理器共用 Space 有效根；已打开的 Git 页面保持自身仓库。 */
import { useRepositoryController } from "./useRepositoryController";

export function useSourceControlContext(
  explorerRoot: string | null,
  foreground: boolean,
  decorationsVisible = false,
) {
  const sourceControl = useRepositoryController(
    explorerRoot,
    foreground || decorationsVisible,
    foreground,
  );
  return { sourceControl };
}
