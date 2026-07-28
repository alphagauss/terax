/**
 * 本文件初始化并创建 CodeMirror Vim 扩展。
 *
 * 模块仅在用户启用 Vim 时动态加载，Ex 命令通过轻量注册表调用所属视图。
 */

import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { Vim, vim } from "@replit/codemirror-vim";
import { getVimHandlers } from "./vimHandlers";

let initialized = false;

/** 注册一次全局 Ex 命令和方向键映射。 */
function initVimGlobals(): void {
  if (initialized) return;
  initialized = true;

  type CmAdapter = { cm6?: EditorView };
  const getView = (cm: CmAdapter) => cm.cm6;

  Vim.defineEx("write", "w", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) getVimHandlers(view)?.save();
  });

  Vim.defineEx("quit", "q", (cm: CmAdapter) => {
    const view = getView(cm);
    if (view) getVimHandlers(view)?.close();
  });

  Vim.defineEx("wq", "wq", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = getVimHandlers(view);
    h?.save();
    h?.close();
  });

  Vim.defineEx("xit", "x", (cm: CmAdapter) => {
    const view = getView(cm);
    if (!view) return;
    const h = getVimHandlers(view);
    h?.save();
    h?.close();
  });

  // Arrow keys are forwarded by the plugin to the editor scope handlers,
  // which breaks operator-pending (d<Up>) and counts (15<Up>). Remap to
  // hjkl so they stay inside the vim state machine.
  Vim.map("<Up>", "k", "normal");
  Vim.map("<Down>", "j", "normal");
  Vim.map("<Left>", "h", "normal");
  Vim.map("<Right>", "l", "normal");
  Vim.map("<Up>", "k", "visual");
  Vim.map("<Down>", "j", "visual");
  Vim.map("<Left>", "h", "visual");
  Vim.map("<Right>", "l", "visual");
}

/** 初始化全局 Vim 命令并创建一个视图扩展。 */
export function createVimExtension(): Extension {
  initVimGlobals();
  return vim();
}
