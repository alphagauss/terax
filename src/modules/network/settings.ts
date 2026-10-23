/**
 * 本文件管理通用设置中以 network. 为前缀的共享代理和连接路由。
 * 界面按需订阅既有共享存储；实际请求由 Rust 读取权威配置，不依赖此展示缓存。
 */
import {
  deleteSharedStoreKey,
  onSharedStoreChange,
  readSharedStore,
  setSharedStoreKey,
} from "@/lib/sharedStore";
import { create } from "zustand";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export type GlobalProxyMode = "system" | "shared" | "direct";
export type ProxyMode = "inherit" | "direct" | "shared";

/** 缺失连接选择表示继承；显式直连必须与未设置区分。 */
export function networkRoute(value: unknown): ProxyMode {
  return value === "direct" || value === "shared" ? value : "inherit";
}

export function globalNetworkMode(value: unknown): GlobalProxyMode {
  return value === "direct" || value === "shared" ? value : "system";
}

/** 展示实际继承的策略，不把派生结果写回连接配置。 */
export function effectiveNetworkMode(
  values: Record<string, unknown>,
  key: NetworkKey,
): GlobalProxyMode {
  const mode = networkRoute(values[key]);
  return mode === "inherit" ? globalNetworkMode(values.mode) : mode;
}
export type NetworkKey =
  | `provider:${string}`
  | `channel:${string}`
  | `speech:${string}`
  | "markdown";

type State = {
  values: Record<string, unknown>;
  ready: boolean;
  error: boolean;
  revision: number;
};

export const useNetworkStore = create<State>(() => ({
  values: {},
  ready: false,
  error: false,
  revision: 0,
}));
let initialization: Promise<void> | null = null;
let systemRevision: string | null = null;
let reloadVersion = 0;

/** 系统代理由设置以外的程序修改，窗口恢复焦点时重新检查缓存身份。 */
async function refreshSystemProxy(): Promise<void> {
  if (globalNetworkMode(useNetworkStore.getState().values.mode) !== "system")
    return;
  // 此修订只用于缓存；读取失败仍由实际请求报告，不能阻止用户改用直连。
  const revision = await invoke<string>("network_system_proxy_revision").catch(
    () => "unavailable",
  );
  if (revision !== systemRevision) {
    systemRevision = revision;
    useNetworkStore.setState((state) => ({ revision: state.revision + 1 }));
  }
}

/** 读取权威配置并更新展示缓存，失败时保留错误状态供设置页重试。 */
async function reload(): Promise<void> {
  const version = ++reloadVersion;
  try {
    const stored = await readSharedStore("settings");
    // 保存与共享变更通知可能交错，迟到的读取不能覆盖较新的权威值。
    if (version !== reloadVersion) return;
    const values = Object.fromEntries(
      Object.entries(stored)
        .filter(([key]) => key.startsWith("network."))
        .map(([key, value]) => [key.slice("network.".length), value]),
    );
    const previous = useNetworkStore.getState();
    useNetworkStore.setState((state) => {
      // 通用设置共用一个文件，主题等无关修改不能使网络缓存失效。
      const changed =
        Object.keys(values).length !== Object.keys(state.values).length ||
        Object.entries(values).some(
          ([key, value]) => !Object.is(state.values[key], value),
        );
      if (!changed && state.ready && !state.error) return state;
      return {
        values: changed ? values : state.values,
        ready: true,
        error: false,
        revision: state.revision + Number(changed),
      };
    });
    if (
      !previous.ready ||
      globalNetworkMode(previous.values.mode) !== globalNetworkMode(values.mode)
    )
      await refreshSystemProxy();
  } catch (error) {
    if (version !== reloadVersion) return;
    useNetworkStore.setState({ error: true });
    throw error;
  }
}

/** 同一设置进程只建立一份订阅；失败后允许重新初始化。 */
async function initialize(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    // 共享订阅会在建立监听后执行首次加载，不提前重复读取。
    const unsubscribe = await onSharedStoreChange("settings", reload);
    try {
      await onSharedStoreChange("keys-epoch", () => {
        // 密钥变化只使模型目录缓存失效，不重复读取未改变的网络配置。
        useNetworkStore.setState((state) => ({ revision: state.revision + 1 }));
      });
      window.addEventListener("focus", () => void refreshSystemProxy());
    } catch (error) {
      unsubscribe();
      throw error;
    }
  })().catch(() => {
    initialization = null;
    useNetworkStore.setState({ error: true });
  });
  return initialization;
}

/** 仅设置控件挂载后加载配置，不为未使用的网络功能创建后台资源。 */
export function useNetworkSettings(): State {
  const state = useNetworkStore();
  useEffect(() => {
    void initialize();
  }, []);
  return state;
}

/** 保存全局策略并同步权威值，提交预览结束时不会短暂退回旧模式。 */
export async function setGlobalNetworkMode(
  mode: GlobalProxyMode,
): Promise<void> {
  await setSharedStoreKey("settings", "network.mode", mode);
  await reload();
}

/** 精确修改单个连接的网络选择，继承不保存冗余记录，手动选择保持独立。 */
export async function setNetworkRoute(
  key: NetworkKey,
  mode: ProxyMode,
): Promise<void> {
  if (mode === "inherit")
    await deleteSharedStoreKey("settings", `network.${key}`);
  else await setSharedStoreKey("settings", `network.${key}`, mode);
  await reload();
}
