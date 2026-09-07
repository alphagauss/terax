/**
 * 本文件汇总 AI 模块的轻量公共入口。
 * 重型聊天运行时保持独立导入，避免进入启动包。
 */

export {
  ApprovalToastHost,
  AiSidebarPanel,
  SelectionAskAi,
} from "./components/lazy";
export { AgentStatusPill } from "./components/AgentStatusPill";
export { useAiBootstrap } from "./hooks/useAiBootstrap";
export { useSelectionAskAi } from "./hooks/useSelectionAskAi";
export { useAiLiveBridge } from "./lib/useAiLiveBridge";
export { LocalAgentNotificationsBridge } from "./components/LocalAgentNotificationsBridge";
export {
  EMPTY_PROVIDER_KEYS,
  getAllKeys,
  getAllProviderInstanceKeys,
  getKey,
  setKey,
  clearKey,
  hasAnyKey,
  type ProviderKeys,
  type ProviderInstanceKeys,
} from "./lib/keyring";
export {
  flushCompletedSessionRuns,
  getActiveProviderKey,
  hasKeyForModel,
  selectActiveAgentMeta,
  useChatStore,
  type AgentMeta,
  type AgentRunStatus,
} from "./store/chatStore";
// Heavy chat runtime (@ai-sdk/react + ai SDK) is intentionally NOT re-exported
// here: this barrel is eagerly imported by App, and a static re-export would
// pull the whole SDK into the startup graph. Import from ./store/chatRuntime.
