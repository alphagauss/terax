import { serializeSpaceWorkbench } from "@/modules/spaces/lib/serialize";
import { deleteSpaceData, saveState } from "@/modules/spaces/lib/store";
import type { WorkbenchState } from "@/modules/workbench";
import { useCallback, useEffect, useRef } from "react";

const DEBOUNCE_MS = 3000;
const EMPTY_STATE = "empty";

type Params = {
  state: WorkbenchState;
  enabled: boolean;
};

export function useSpacePersistence({ state, enabled }: Params) {
  const last = useRef(new Map<string, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(state);
  latest.current = state;

  const flush = useCallback((snapshot: WorkbenchState) => {
    for (const spaceId of Object.keys(snapshot.spaces)) {
      const workbench = serializeSpaceWorkbench(snapshot, spaceId);
      if (!workbench) {
        if (last.current.get(spaceId) === EMPTY_STATE) continue;
        last.current.set(spaceId, EMPTY_STATE);
        void deleteSpaceData(spaceId);
        continue;
      }
      const json = JSON.stringify(workbench);
      if (last.current.get(spaceId) === json) continue;
      last.current.set(spaceId, json);
      void saveState(spaceId, { version: 2, workbench });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      flush(state);
    }, DEBOUNCE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled, flush, state]);

  useEffect(() => {
    if (!enabled) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush(latest.current);
    };
    const onLeave = () => flush(latest.current);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("blur", onLeave);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("beforeunload", onLeave);
      flush(latest.current);
    };
  }, [enabled, flush]);
}
