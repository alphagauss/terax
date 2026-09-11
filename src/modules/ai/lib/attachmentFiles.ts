/** 附件的原生选择与内容读取；本机选择器和工作区读取使用各自的环境边界。 */
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceEnv } from "@/modules/workspace";

export async function pickNativeAttachments(
  workspace: WorkspaceEnv,
  title: string,
  attach: (path: string) => Promise<void>,
): Promise<void> {
  if (workspace.kind !== "local") return;
  const paths = await open({ multiple: true, directory: false, title });
  if (!paths) return;
  for (const path of Array.isArray(paths) ? paths : [paths]) await attach(path);
}

const IMAGE_MEDIA_TYPES = new Map(
  Object.entries({
    avif: "image/avif",
    bmp: "image/bmp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    ico: "image/x-icon",
    jfif: "image/jpeg",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    webp: "image/webp",
  }),
);

type PathAttachment =
  | { kind: "text"; content: string; size: number }
  | { kind: "binary" | "toolarge"; size: number }
  | { kind: "image"; url: string; mediaType: string; size: number };

/** 图片只读取一次二进制；其他文件由原生侧校验 UTF-8 和大小限制。 */
export async function readPathAttachment(
  path: string,
  workspace: WorkspaceEnv,
): Promise<PathAttachment> {
  const extension =
    path.split(/[\\/]/).pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "";
  const mediaType = IMAGE_MEDIA_TYPES.get(extension);
  if (!mediaType)
    return invoke<PathAttachment>("fs_read_file", { path, workspace });
  const binary = await invoke<{ bytes: number[]; size: number }>(
    "fs_read_binary",
    { path, workspace },
  );
  const url = await readAsDataURL(
    new Blob([new Uint8Array(binary.bytes)], { type: mediaType }),
  );
  return { kind: "image", mediaType, url, size: binary.size };
}

export function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
