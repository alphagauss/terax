/** Composer 接收宿主文件拖放和当前环境资源拖放，命中区域与环境策略分别判断。 */
import { useEffect, useRef, useState } from "react";
import { nativeDropElementAt } from "@/lib/nativeFileDrop";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { useComposer } from "@/modules/ai/lib/composer";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { registerResourceDropTarget } from "@/modules/file-actions/resourceDrop";

export function useComposerDrop(composer: ReturnType<typeof useComposer>) {
  const { t } = useTranslation("ai");
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef(composer);
  current.current = composer;
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const unregister = registerResourceDropTarget({
      element,
      hover: setHovered,
      drop: (path) => {
        if (current.current.readOnly) return;
        if (!current.current.canPickFiles) {
          toast.info(t("common:fileActions.remoteFileInputRejected"));
          return;
        }
        void current.current.attachFileByPath(path);
      },
    });
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (disposed) return;
        if (payload.type === "leave") {
          setHovered(false);
          return;
        }
        const hit = nativeDropElementAt(payload.position.x, payload.position.y);
        const inside = hit !== null && element.contains(hit);
        if (payload.type !== "drop") {
          setHovered(inside);
          return;
        }
        setHovered(false);
        if (!inside || current.current.readOnly || !payload.paths.length)
          return;
        if (!current.current.canPickFiles) {
          toast.info(t("common:fileActions.remoteFileInputRejected"));
          return;
        }
        const session = useChatStore.getState().activeSessionId;
        void (async () => {
          for (const path of new Set(payload.paths)) {
            if (
              disposed ||
              current.current.readOnly ||
              useChatStore.getState().activeSessionId !== session
            )
              return;
            await current.current.attachFileByPath(path);
          }
        })();
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error) =>
        console.error("[composer] drop listener failed", error),
      );
    return () => {
      disposed = true;
      unregister();
      unlisten?.();
    };
  }, [t]);
  return {
    ref,
    active: hovered && !composer.readOnly && composer.canPickFiles,
  };
}
