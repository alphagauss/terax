/** 当前会话的展示可见性；隐藏只暂停展示订阅，不影响运行时和已挂载的局部状态。 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { StoreApi } from "zustand";

export const ChatDisplayContext = createContext(true);

export function useChatDisplayActive() {
  return useContext(ChatDisplayContext);
}

/** 隐藏时保留最后一次展示快照，恢复时直接读取最新业务状态。 */
export function useChatDisplaySnapshot<T>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => T,
): T {
  const active = useChatDisplayActive();
  const last = useRef<{ value: T } | null>(null);
  const read = useCallback(() => {
    if (active || !last.current) last.current = { value: getSnapshot() };
    return last.current.value;
  }, [active, getSnapshot]);
  const listen = useCallback(
    (listener: () => void) => (active ? subscribe(listener) : () => {}),
    [active, subscribe],
  );
  return useSyncExternalStore(listen, read, read);
}

/** 仅用于会话展示投影；业务写入仍直接使用原始 store。 */
export function useChatDisplayStore<T, U>(
  store: StoreApi<T>,
  selector: (state: T) => U,
): U {
  const read = useCallback(() => selector(store.getState()), [store, selector]);
  return useChatDisplaySnapshot(store.subscribe, read);
}
