/**
 * 本文件连接 Vim Ex 命令与所属编辑器视图的保存、关闭动作。
 *
 * 注册表本身不依赖 Vim 包，使普通编辑模式无需加载 Vim 状态机。
 */

import type { Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";

export type VimHandlers = { save: () => void; close: () => void };

const handlers = new WeakMap<EditorView, VimHandlers>();

/** 返回指定 CodeMirror 视图当前注册的 Vim 动作。 */
export function getVimHandlers(view: EditorView): VimHandlers | undefined {
  return handlers.get(view);
}

/** 注册一个视图的 Vim 保存与关闭动作。 */
export function vimHandlersExtension(
  getHandlers: () => VimHandlers,
): Extension {
  return ViewPlugin.define((view) => {
    handlers.set(view, getHandlers());
    return {
      update() {
        handlers.set(view, getHandlers());
      },
      destroy() {
        handlers.delete(view);
      },
    };
  });
}
