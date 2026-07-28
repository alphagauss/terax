/**
 * 本文件按需加载 CodeMirror Vim 扩展。
 *
 * 未启用 Vim 时不下载或执行其状态机，加载完成后由 compartment 接入现有视图。
 */

import type { Extension } from "@codemirror/state";
import { useEffect, useState } from "react";

/** 根据偏好异步取得 Vim 扩展，禁用或取消加载时返回空值。 */
export function useVimExtension(enabled: boolean): Extension | null {
  const [extension, setExtension] = useState<Extension | null>(null);

  useEffect(() => {
    if (!enabled) {
      setExtension(null);
      return;
    }

    let cancelled = false;
    void import("./vim")
      .then(({ createVimExtension }) => {
        if (!cancelled) setExtension(createVimExtension());
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[editor] Vim extension load failed", error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return extension;
}
