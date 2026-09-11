/** 系统剪贴板文件入口只返回真实路径，不把文本或内存图片转换为文件。 */
import { invoke } from "@tauri-apps/api/core";

export function readClipboardFiles(): Promise<string[]> {
  return invoke<string[]>("clipboard_read_files");
}
