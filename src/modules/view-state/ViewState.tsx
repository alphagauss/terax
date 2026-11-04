/** 统一侧边栏与工作页的展示生命周期和会话内状态；不拥有业务运行时。 */

import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useState,
  useRef,
  useMemo,
  useLayoutEffect,
  useSyncExternalStore,
} from "react";
import { createSnapshotCache, snapshotBytes } from "./cache";

type Values = Record<string, { value: unknown; bytes: number }>;
const sidebarStates = createSnapshotCache<Values>(9);
const pageStates = createSnapshotCache<Values>(64);
const ViewContext = createContext<{
  scope: string;
  prefix: string;
  cache: typeof sidebarStates;
  visible: boolean;
} | null>(null);

const subscribeVisibility = (listener: () => void) => {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};
const windowVisible = () => document.visibilityState !== "hidden";

/** 容器提供稳定身份和真实可见性，视图移动和隐藏不改变运行实例。 */
export function ViewStateScope({
  scope,
  view,
  visible,
  kind,
  children,
}: {
  scope: string;
  view: string;
  visible: boolean;
  kind: "sidebar" | "page";
  children: ReactNode;
}) {
  const context = useMemo(
    () => ({
      scope,
      prefix: view,
      visible,
      cache: kind === "sidebar" ? sidebarStates : pageStates,
    }),
    [scope, view, visible, kind],
  );
  useLayoutEffect(
    () => (visible ? context.cache.retain(scope) : undefined),
    [scope, visible, context.cache],
  );
  return (
    <ViewContext.Provider value={context}>{children}</ViewContext.Provider>
  );
}

/** 可见但失焦仍活跃；窗口隐藏、侧栏隐藏、离开 Space 均暂停展示读取。 */
export function useViewActive(enabled = true): boolean {
  const context = useContext(ViewContext);
  const visible = useSyncExternalStore(
    subscribeVisibility,
    windowVisible,
    () => true,
  );
  return enabled && visible && (context?.visible ?? true);
}

export function useViewScopeKey(): string {
  const context = useContext(ViewContext);
  return context ? `${context.scope}\0${context.prefix}` : "";
}

function writeValue(
  cache: typeof sidebarStates,
  scope: string,
  key: string,
  value: unknown,
) {
  const values = {
    ...cache.get(scope),
    [key]: { value, bytes: snapshotBytes(value) + key.length * 2 },
  };
  cache.set(
    scope,
    values,
    Object.values(values).reduce((size, item) => size + item.bytes, 0),
  );
}

/** 非渲染状态直接读写，仅计算更新字段的大小，滚动不会序列化整个视图快照。 */
export function useViewMemory<T>(slot: string) {
  const context = useContext(ViewContext);
  const key = `${context?.prefix ?? ""}\0${slot}`;
  const cache = context?.cache;
  const scope = context?.scope;
  return useMemo(
    () => ({
      read: () =>
        scope === undefined
          ? undefined
          : (cache?.get(scope)?.[key]?.value as T | undefined),
      write: (value: T) => {
        if (cache && scope !== undefined) writeValue(cache, scope, key, value);
      },
    }),
    [cache, scope, key],
  );
}

/** 按容器身份保存可丢弃 UI 状态；异步读取仍须由业务请求域隔离陈旧结果。 */
export function useViewState<T>(
  slot: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const context = useContext(ViewContext);
  const scope = context?.scope ?? "";
  const key = `${context?.prefix ?? ""}\0${slot}`;
  const cache = context?.cache;
  const read = () => {
    const values = cache?.get(scope);
    if (values && key in values) return values[key].value as T;
    const value =
      typeof initial === "function" ? (initial as () => T)() : initial;
    // 默认布局也属于视图快照，不能在其他 Space 修改全局偏好后被重新初始化。
    if (cache) writeValue(cache, scope, key, value);
    return value;
  };
  const [state, setState] = useState(() => ({ scope, key, value: read() }));
  let value = state.value;
  if (state.scope !== scope || state.key !== key) {
    value = read();
    setState({ scope, key, value });
  }
  const identity = useRef({ cache, scope, key });
  identity.current = { cache, scope, key };
  const set = useCallback<Dispatch<SetStateAction<T>>>((update) => {
    const { cache, scope, key } = identity.current;
    setState((current) => {
      const belongs = current.scope === scope && current.key === key;
      if (!belongs) return current;
      const previous = current.value;
      const next =
        typeof update === "function"
          ? (update as (value: T) => T)(previous)
          : update;
      if (Object.is(next, previous)) return current;
      if (cache) writeValue(cache, scope, key, next);
      return { scope, key, value: next };
    });
  }, []);
  return [value, set];
}

/** 关闭 Space 或工作页时释放其专属视图状态，共享资源缓存仍由 LRU 管理。 */
export function pruneViewStates(
  spaces: ReadonlySet<string>,
  tabs: ReadonlySet<string>,
) {
  sidebarStates.prune((key) => spaces.has(key.split("\0")[0]));
  pageStates.prune((key) => tabs.has(key));
}
