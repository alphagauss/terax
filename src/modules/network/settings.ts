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

export type ProxyMode = "direct" | "shared";
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

/** 读取权威配置并更新展示缓存，失败时保留错误状态供设置页重试。 */
async function reload(): Promise<void> {
  try {
    const stored = await readSharedStore("settings");
    const values = Object.fromEntries(
      Object.entries(stored)
        .filter(([key]) => key.startsWith("network."))
        .map(([key, value]) => [key.slice("network.".length), value]),
    );
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
  } catch (error) {
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

/** 精确修改单个连接的网络选择，默认直连不保存冗余记录。 */
export async function setNetworkRoute(
  key: NetworkKey,
  mode: ProxyMode,
): Promise<void> {
  if (mode === "direct")
    await deleteSharedStoreKey("settings", `network.${key}`);
  else await setSharedStoreKey("settings", `network.${key}`, mode);
  await reload();
}
