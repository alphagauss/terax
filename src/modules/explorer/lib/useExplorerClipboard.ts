/**
 * 文件树剪贴板在当前窗口内共享，原生粘贴成功后才消费对应的剪切记录。
 */

import { IS_MAC } from "@/lib/platform";
import { type WorkspaceEnv, workspaceScopeKey } from "@/modules/workspace/env";
import { invoke } from "@tauri-apps/api/core";
import type { TFunction } from "i18next";
import { create } from "zustand";

type Mode = "copy" | "cut";
type ClipboardEntry = {
  path: string;
  isDir: boolean;
  mode: Mode;
  scope: string;
};

const useClipboard = create<{
  entry: ClipboardEntry | null;
  pasting: boolean;
}>(() => ({ entry: null, pasting: false }));

type ClipboardCommand = Mode | "paste" | "pasteSystem" | "cancelCut";

export function explorerPasteError(t: TFunction<"explorer">, error: unknown) {
  const failure = error as { kind?: string; detail?: string } | null;
  if (failure?.kind === "descendant") return t("menu.pasteDescendant");
  if (failure?.kind === "invalidPath") return t("menu.pasteInvalidPath");
  if (failure?.kind === "unavailable") return t("menu.pasteUnavailable");
  if (failure?.kind === "crossDevice") return t("menu.pasteCrossDevice");
  if (failure?.kind === "namesExhausted") return t("menu.pasteNamesExhausted");
  return t("menu.pasteFailed", { error: failure?.detail ?? String(error) });
}

/** 识别文件树专用快捷键，调用方先排除正在编辑文本的目标。 */
export function explorerClipboardCommand(
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
): ClipboardCommand | undefined {
  const { key, ctrlKey, metaKey, altKey, shiftKey } = event;
  if (altKey) return;
  if (!ctrlKey && !metaKey) {
    if (shiftKey && key === "Insert") return "pasteSystem";
    if (!shiftKey && key === "Escape") return "cancelCut";
    return;
  }
  if (shiftKey || !(IS_MAC ? metaKey && !ctrlKey : ctrlKey && !metaKey)) return;
  switch (key.toLowerCase()) {
    case "x":
      return "cut";
    case "c":
      return "copy";
    case "v":
      return "paste";
  }
}

/** 同一窗口的 Space 共用文件剪贴板，粘贴按发起时的来源和目标执行。 */
export function useExplorerClipboard(
  workspace: WorkspaceEnv,
  pasteSystemFiles: (destination: string) => Promise<void>,
) {
  const scope = workspaceScopeKey(workspace);
  const entry = useClipboard((state) =>
    state.entry?.scope === scope ? state.entry : null,
  );
  const pasting = useClipboard((state) => state.pasting);

  const remember = (mode: Mode, path: string, isDir: boolean) => {
    useClipboard.setState({ entry: { mode, path, isDir, scope } });
  };
  const cancelCut = () => {
    const { entry, pasting } = useClipboard.getState();
    if (pasting || entry?.scope !== scope || entry.mode !== "cut") return false;
    useClipboard.setState({ entry: null });
    return true;
  };

  const paste = async (
    destination: string,
    parentOf: (path: string) => string,
    system: boolean,
  ) => {
    const current = useClipboard.getState();
    if (current.pasting) return;
    useClipboard.setState({ pasting: true });
    try {
      const source = current.entry;
      if (system || source?.scope !== scope) {
        await pasteSystemFiles(destination);
        return;
      }
      const targetDir =
        source.isDir && source.path === destination
          ? parentOf(source.path)
          : destination;
      const name = await invoke<string>("fs_paste", {
        source: source.path,
        destination: targetDir,
        mode: source.mode,
        workspace,
      });
      if (source.mode === "cut" && useClipboard.getState().entry === source) {
        useClipboard.setState({ entry: null });
      }
      return { source, targetDir, name };
    } finally {
      useClipboard.setState({ pasting: false });
    }
  };

  return { entry, pasting, remember, cancelCut, paste };
}
