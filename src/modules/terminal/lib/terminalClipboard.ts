/** 终端粘贴优先处理文件路径；远端拒绝宿主文件，内存图片不会生成临时文件。 */
import { readClipboardFiles } from "@/modules/file-actions/clipboard";
import { currentWorkspaceEnv } from "@/modules/workspace";
import { formatDroppedPaths } from "@/modules/terminal/lib/quoteShellPath";
import { toast } from "sonner";
import i18n from "@/i18n";

/** 拖放与粘贴共用终端宿主文件策略，不上传文件或自动提交命令。 */
export function terminalFilePaths(paths: string[]): string {
  if (!paths.length) return "";
  if (currentWorkspaceEnv().kind !== "local") {
    toast.info(i18n.t("common:fileActions.remoteFileInputRejected"));
    return "";
  }
  return formatDroppedPaths([...new Set(paths)]);
}

// Linux 文本读取使用原生插件，其他平台维持浏览器文本剪贴板入口。
const IS_LINUX =
  typeof navigator !== "undefined" &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

function webClipboard(): Clipboard | null {
  if (typeof navigator === "undefined") return null;
  return navigator.clipboard ?? null;
}

export async function readTerminalClipboard(): Promise<string> {
  try {
    const paths = await readClipboardFiles();
    if (paths.length) return terminalFilePaths(paths);
  } catch {
    toast.error(i18n.t("common:fileActions.clipboardReadFailed"));
    return "";
  }
  if (IS_LINUX) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    } catch {}
  }
  try {
    return (await webClipboard()?.readText()) ?? "";
  } catch {
    return "";
  }
}

export async function writeTerminalClipboard(text: string): Promise<void> {
  if (IS_LINUX) {
    try {
      const { writeText } = await import(
        "@tauri-apps/plugin-clipboard-manager"
      );
      await writeText(text);
      return;
    } catch {}
  }
  try {
    await webClipboard()?.writeText(text);
  } catch {}
}
