/**
 * 本文件汇总 Workspace 环境模型与进程内环境状态的公共接口。
 * SSH 连接生命周期不属于本模块，由 Remote Runtime 单独管理。
 */

export {
  currentWorkspaceScopeKey,
  currentWorkspaceEnv,
  getWslHome,
  LOCAL_WORKSPACE,
  parseWorkspaceScopeKey,
  useWorkspaceEnvStore,
  workspaceScopeKey,
  type WorkspaceEnv,
  type WslDistro,
} from "./env";
