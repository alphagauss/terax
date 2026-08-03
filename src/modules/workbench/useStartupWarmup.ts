/**
 * 本文件调度 Workspace 启动后的页面预热。
 *
 * 调度器只依次允许终端、编辑器和 Markdown 挂载，不等待各页面内部异步流程完成，
 * 也不改变活动 Space、Group、标签或焦点。
 */

import type { Tab, WorkbenchState } from "@/modules/workbench/types";
import { whenSessionReady } from "@/modules/terminal";
import { useEffect, useRef } from "react";

export const STARTUP_WARMUP_GAP_MS = 400;

type WarmableTab = Extract<Tab, { kind: "terminal" | "editor" | "markdown" }>;

type Params = {
  enabled: boolean;
  state: WorkbenchState;
  activeSpaceId: string;
  activeTab: Tab | undefined;
  warmTabInBackground: (tabId: number) => void;
};

function isWarmableTab(tab: Tab): tab is WarmableTab {
  return (
    tab.kind === "terminal" || tab.kind === "editor" || tab.kind === "markdown"
  );
}

function kindPriority(tab: WarmableTab): number {
  if (tab.kind === "terminal") return 0;
  if (tab.kind === "editor") return 1;
  return 2;
}

/** 收集启动时允许后台预热的冷标签，排除 Web Preview、Alpha 和临时页面。 */
export function collectStartupWarmupIds(state: WorkbenchState): Set<number> {
  return new Set(
    Object.values(state.tabs)
      .filter((tab) => tab.cold && isWarmableTab(tab))
      .map((tab) => tab.id),
  );
}

/**
 * 从仍然存在且尚未挂载的启动标签中选择下一项。
 *
 * 当前 Space 优先，同一 Space 内按终端、编辑器、Markdown 和标签 ID 稳定排序。
 */
export function pickNextStartupWarmupTab(
  state: WorkbenchState,
  activeSpaceId: string,
  pendingIds: ReadonlySet<number>,
): Tab | null {
  const candidates = [...pendingIds]
    .map((id) => state.tabs[id])
    .filter(
      (tab): tab is WarmableTab =>
        Boolean(tab?.cold) && tab !== undefined && isWarmableTab(tab),
    );
  candidates.sort((left, right) => {
    const leftSpace = left.spaceId === activeSpaceId ? 0 : 1;
    const rightSpace = right.spaceId === activeSpaceId ? 0 : 1;
    return (
      leftSpace - rightSpace ||
      kindPriority(left) - kindPriority(right) ||
      left.id - right.id
    );
  });
  return candidates[0] ?? null;
}

/** 在浏览器空闲时执行一次回调，并为不支持 Idle Callback 的 WebView 提供定时器回退。 */
function scheduleIdle(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const handle = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1500,
    });
    return () => globalThis.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 50);
  return () => window.clearTimeout(handle);
}

/**
 * 在前台页面稳定后依次启动恢复页面的后台挂载。
 *
 * 用户切换标签时会重启等待窗口；已开始的页面初始化由页面自身继续管理，不尝试取消。
 */
export function useStartupWarmup({
  enabled,
  state,
  activeSpaceId,
  activeTab,
  warmTabInBackground,
}: Params): void {
  const stateRef = useRef(state);
  stateRef.current = state;
  const pendingRef = useRef<Set<number> | null>(null);
  const activeTerminalId = activeTab?.kind === "terminal" ? activeTab.id : null;

  useEffect(() => {
    if (!enabled || pendingRef.current !== null) return;
    pendingRef.current = collectStartupWarmupIds(stateRef.current);
  }, [enabled]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 非终端标签切换也必须取消并重排后台预热。
  useEffect(() => {
    if (!enabled || pendingRef.current === null) return;
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    let gapTimer: number | null = null;

    const scheduleNext = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      cancelIdle = scheduleIdle(() => {
        cancelIdle = null;
        if (cancelled || document.visibilityState === "hidden") return;
        const pending = pendingRef.current;
        if (!pending) return;
        const next = pickNextStartupWarmupTab(
          stateRef.current,
          activeSpaceId,
          pending,
        );
        if (!next) return;
        pending.delete(next.id);
        warmTabInBackground(next.id);
        gapTimer = window.setTimeout(() => {
          gapTimer = null;
          scheduleNext();
        }, STARTUP_WARMUP_GAP_MS);
      });
    };

    const begin = () => {
      if (activeTerminalId !== null) {
        void whenSessionReady(activeTerminalId).then(() => {
          if (!cancelled) scheduleNext();
        });
        return;
      }
      scheduleNext();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && !cancelIdle && !gapTimer) {
        begin();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    begin();
    return () => {
      cancelled = true;
      cancelIdle?.();
      if (gapTimer !== null) window.clearTimeout(gapTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [
    activeSpaceId,
    activeTab?.id,
    activeTerminalId,
    enabled,
    warmTabInBackground,
  ]);
}
