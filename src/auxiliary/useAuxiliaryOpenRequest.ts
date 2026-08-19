/**
 * 本文件订阅辅助窗口的版本化打开请求。
 * 页面先建立事件监听再读取原生快照，快速复用窗口时只接受最新版本。
 */

import {
  AUXILIARY_OPEN_EVENT,
  getAuxiliaryWindowRequest,
  type AuxiliaryWindowOpenEnvelope,
} from "@/auxiliary/openAuxiliaryWindow";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, useState } from "react";

/** 返回当前辅助窗口最近一次打开请求，并屏蔽乱序的旧事件。 */
export function useAuxiliaryOpenRequest(): AuxiliaryWindowOpenEnvelope | null {
  const [envelope, setEnvelope] = useState<AuxiliaryWindowOpenEnvelope | null>(
    null,
  );
  const revisionRef = useRef(0);

  useEffect(() => {
    let active = true;
    const accept = (next: AuxiliaryWindowOpenEnvelope) => {
      if (!active || next.revision <= revisionRef.current) return;
      revisionRef.current = next.revision;
      setEnvelope(next);
    };
    const unlistenPromise = getCurrentWebviewWindow()
      .listen<AuxiliaryWindowOpenEnvelope>(AUXILIARY_OPEN_EVENT, (event) => {
        accept(event.payload);
      })
      .then(async (unlisten) => {
        try {
          accept(await getAuxiliaryWindowRequest());
        } catch (error) {
          console.error("读取辅助窗口打开请求失败", error);
        }
        return unlisten;
      });

    return () => {
      active = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return envelope;
}
