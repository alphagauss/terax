/** 项目主动复制的统一入口；Windows 保留系统历史，Linux 避开 WebKit 剪贴板限制。 */
import { IS_LINUX, IS_WINDOWS } from "@/lib/platform";

export const USE_NATIVE_CLIPBOARD = IS_WINDOWS || IS_LINUX;

/** 原生写入失败向调用方报告，不回退到无法保证历史记录的网页写入。 */
export async function writeClipboardText(text: string): Promise<void> {
  if (USE_NATIVE_CLIPBOARD) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }
  await navigator.clipboard.writeText(text);
}

/** 同时保留 HTML 和纯文本表示，让粘贴目标选择支持的格式。 */
export async function writeClipboardHtml(
  html: string,
  text: string,
): Promise<void> {
  if (USE_NATIVE_CLIPBOARD) {
    const { writeHtml } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeHtml(html, text);
    return;
  }
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
  } else {
    await writeClipboardText(text);
  }
}
