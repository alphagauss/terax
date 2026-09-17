/**
 * 本文件初始化 AI 偏好、密钥、会话和跨窗口刷新监听。
 *
 * 后台同步失败交由会话状态提示，避免未处理的 Promise 拒绝中断刷新周期。
 */

import { useRemoteRuntimeStore } from "@/modules/remote";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { modelRefKey, modelRefsEqual } from "../config";
import {
  listExternalAgents,
  parseExternalAgentBinding,
} from "../external-agents/runtime";
import { getAllKeys, getAllProviderInstanceKeys } from "../lib/keyring";
import {
  getAvailableModelRefs,
  selectAvailableModel,
} from "../lib/modelAvailability";
import { useAgentsStore } from "../store/agentsStore";
import {
  flushCompletedSessionRuns,
  sessionMetadata,
  useChatStore,
} from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

/**
 * 初始化 AI 子系统并保持提供商密钥同步。
 * 同时加载偏好、会话、Agent 与片段状态，并返回应用外壳需要的派生标记。
 */
export function useAiBootstrap(): {
  hasComposer: boolean;
  keysLoaded: boolean;
} {
  const apiKeys = useChatStore((s) => s.apiKeys);
  const setApiKeys = useChatStore((s) => s.setApiKeys);
  const setProviderInstanceKeys = useChatStore(
    (s) => s.setProviderInstanceKeys,
  );
  const setSelectedModel = useChatStore((s) => s.setSelectedModel);
  const selectedModel = useChatStore((s) => s.selectedModel);
  const hydrateSessions = useChatStore((s) => s.hydrateSessions);
  const refreshSessions = useChatStore((s) => s.refreshSessions);
  const sessionsHydrated = useChatStore((s) => s.sessionsHydrated);
  const sessionSyncError = useChatStore((s) => s.sessionSyncError);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const remoteRuntimeVersion = useRemoteRuntimeStore(
    (state) => state.snapshot.version,
  );
  const externalAgentAvailability = useChatStore(
    (s) => s.externalAgentAvailability,
  );
  const setExternalAgentAvailability = useChatStore(
    (s) => s.setExternalAgentAvailability,
  );

  const providerModels = usePreferencesStore((s) => s.providerModels);
  const providerBaseURLs = usePreferencesStore((s) => s.providerBaseURLs);
  const customProviders = usePreferencesStore((s) => s.customProviders);
  const availableModels = useMemo(
    () =>
      getAvailableModelRefs({
        apiKeys,
        providerModels,
        providerBaseURLs,
        customProviders,
      }),
    [apiKeys, customProviders, providerBaseURLs, providerModels],
  );
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const hasComposer =
    availableModels.length > 0 ||
    externalAgentAvailability?.some((agent) => agent.installed) === true ||
    Boolean(
      activeSession &&
        (parseExternalAgentBinding(sessionMetadata.get(activeSession.id)) ||
          activeSession.channelId),
    );

  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    if (!prefsHydrated) return;
    let alive = true;
    let revision = 0;
    const reload = () => {
      const requestRevision = ++revision;
      // 两类凭据均就绪后才启动后台连接，较早的刷新结果不能覆盖最新密钥。
      void Promise.all([
        getAllKeys(),
        getAllProviderInstanceKeys(
          usePreferencesStore.getState().customProviders,
        ),
      ]).then(([keys, instanceKeys]) => {
        if (!alive || requestRevision !== revision) return;
        setApiKeys(keys);
        setProviderInstanceKeys(instanceKeys);
        setKeysLoaded(true);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys, setProviderInstanceKeys, prefsHydrated]);

  // 初始化跨窗口偏好，并优先恢复桌面最近一次选择的完整模型身份。
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModel);
  const prefDesktopModel = usePreferencesStore((s) => s.desktopModel);
  const prefDesktopModelParameterSelections = usePreferencesStore(
    (s) => s.desktopModelParameterSelections,
  );
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModel(prefDesktopModel ?? prefDefaultModel, false);
  }, [prefsHydrated, prefDefaultModel, prefDesktopModel, setSelectedModel]);

  useEffect(() => {
    if (!prefsHydrated || !sessionsHydrated || !prefDesktopModel) return;
    const { draftSessionId, parameterSelectionsBySession } =
      useChatStore.getState();
    if (!draftSessionId || parameterSelectionsBySession[draftSessionId]) return;
    useChatStore.setState({
      parameterSelectionsBySession: {
        ...parameterSelectionsBySession,
        [draftSessionId]: {
          [modelRefKey(prefDesktopModel)]: prefDesktopModelParameterSelections,
        },
      },
    });
  }, [
    prefDesktopModel,
    prefDesktopModelParameterSelections,
    prefsHydrated,
    sessionsHydrated,
  ]);

  useEffect(() => {
    if (!prefsHydrated || !keysLoaded) return;
    const replacement = selectAvailableModel(
      selectedModel,
      prefDesktopModel ?? prefDefaultModel,
      availableModels,
    );
    if (
      replacement === selectedModel ||
      (replacement &&
        selectedModel &&
        modelRefsEqual(replacement, selectedModel))
    ) {
      return;
    }
    setSelectedModel(replacement, false);
  }, [
    availableModels,
    keysLoaded,
    prefDefaultModel,
    prefDesktopModel,
    prefsHydrated,
    selectedModel,
    setSelectedModel,
  ]);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: SSH Runtime 重连后必须在新 epoch 的远端环境重新探测 CLI。
  useEffect(() => {
    let alive = true;
    void listExternalAgents()
      .then((availability) => {
        if (alive) setExternalAgentAvailability(availability);
      })
      .catch(() => {
        if (alive) setExternalAgentAvailability([]);
      });
    return () => {
      alive = false;
    };
  }, [remoteRuntimeVersion, setExternalAgentAvailability]);

  useEffect(() => {
    if (!sessionsHydrated) return;
    let refreshing = false;
    const refresh = () => {
      if (refreshing) return;
      refreshing = true;
      void flushCompletedSessionRuns()
        .catch(() => undefined)
        .then(refreshSessions)
        .finally(() => {
          refreshing = false;
        });
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState === "visible") refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 3_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionsHydrated, refreshSessions]);

  useEffect(() => {
    if (!sessionSyncError) return;
    toast.error("AI session sync failed", { description: sessionSyncError });
  }, [sessionSyncError]);

  return { hasComposer, keysLoaded };
}
