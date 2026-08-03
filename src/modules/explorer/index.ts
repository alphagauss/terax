/**
 * 本文件导出 Explorer 视图和后台目录预取能力。
 * 文件树缓存保持在各自 Workspace 进程内，不跨环境共享。
 */

export { ExplorerSearch } from "./ExplorerSearch";
export { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
export { useExplorerDirectoryPrefetch } from "./lib/useExplorerDirectoryPrefetch";
