/**
 * 本文件初始化 AI 偏好、密钥、会话和跨窗口刷新监听。
 *
 * 后台同步失败交由会话状态提示，避免未处理的 Promise 拒绝中断刷新周期。
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { DEFAULT_MODEL_REF, modelRefsEqual } from "../config";
import { getAllProviderInstanceKeys, getAllKeys } from "../lib/keyring";
import {
  getAvailableModelRefs,
  selectAvailableModel,
} from "../lib/modelAvailability";
import { useAgentsStore } from "../store/agentsStore";
import { flushCompletedSessionRuns, useChatStore } from "../store/chatStore";
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

  const providerModels = usePreferencesStore((s) => s.providerModels);
  const lmstudioBaseURL = usePreferencesStore((s) => s.lmstudioBaseURL);
  const mlxBaseURL = usePreferencesStore((s) => s.mlxBaseURL);
  const ollamaBaseURL = usePreferencesStore((s) => s.ollamaBaseURL);
  const customProviders = usePreferencesStore((s) => s.customProviders);
  const availableModels = useMemo(
    () =>
      getAvailableModelRefs({
        apiKeys,
        providerModels,
        lmstudioBaseURL,
        mlxBaseURL,
        ollamaBaseURL,
        customProviders,
      }),
    [
      apiKeys,
      customProviders,
      lmstudioBaseURL,
      mlxBaseURL,
      ollamaBaseURL,
      providerModels,
    ],
  );
  const hasComposer = availableModels.length > 0;

  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  const [keysLoaded, setKeysLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const reload = () => {
      void getAllKeys().then((keys) => {
        if (!alive) return;
        setApiKeys(keys);
        setKeysLoaded(true);
      });
      if (!prefsHydrated) return;
      void getAllProviderInstanceKeys(
        usePreferencesStore.getState().customProviders,
      ).then((instanceKeys) => {
        if (!alive) return;
        setProviderInstanceKeys(instanceKeys);
      });
    };
    reload();
    const unlistenP = onKeysChanged(reload);
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, [setApiKeys, setProviderInstanceKeys, prefsHydrated]);

  // 初始化跨窗口偏好，并让聊天下拉框反映设置页保存的默认模型。
  const initPrefs = usePreferencesStore((s) => s.init);
  const prefDefaultModel = usePreferencesStore((s) => s.defaultModel);
  useEffect(() => {
    void initPrefs();
  }, [initPrefs]);
  useEffect(() => {
    if (!prefsHydrated) return;
    setSelectedModel(prefDefaultModel, false);
  }, [prefsHydrated, prefDefaultModel, setSelectedModel]);

  useEffect(() => {
    if (!prefsHydrated || !keysLoaded) return;
    const replacement =
      selectAvailableModel(selectedModel, prefDefaultModel, availableModels) ??
      DEFAULT_MODEL_REF;
    if (modelRefsEqual(replacement, selectedModel)) return;
    setSelectedModel(replacement, false);
  }, [
    availableModels,
    keysLoaded,
    prefDefaultModel,
    prefsHydrated,
    selectedModel,
    setSelectedModel,
  ]);

  useEffect(() => {
    void hydrateSessions();
    void useAgentsStore.getState().hydrate();
    void useSnippetsStore.getState().hydrate();
  }, [hydrateSessions]);

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
