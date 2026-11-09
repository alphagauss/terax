import { writeClipboardText } from "@/lib/clipboard";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

export async function copyToClipboard(text: string): Promise<void> {
  try {
    await writeClipboardText(text);
  } catch {
    // Best-effort; ignore in environments without clipboard permission.
  }
}

/** 计算根目录下的相对路径，根目录外的路径保留原值。 */
export function relativePath(
  rootPath: string,
  path: string,
  ignoreCase = false,
): string {
  const matches = (left: string, right: string) =>
    left.length === right.length &&
    (ignoreCase ? left.toLowerCase() === right.toLowerCase() : left === right);
  if (matches(path, rootPath)) return ".";
  const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;
  return matches(path.slice(0, prefix.length), prefix)
    ? path.slice(prefix.length)
    : path;
}

export async function revealInFinder(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.error("revealItemInDir failed:", e);
  }
}
