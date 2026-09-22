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
  | { kind: "file"; size: number }
  | { kind: "binary" | "unsupported"; size: number }
  | { kind: "image"; url: string; mediaType: string; size: number };

/** 常见图片优先按签名识别，避免平台默认文件名或错误扩展名改变 MIME。 */
function imageMediaType(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (starts(0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
    return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP")
    return "image/webp";
  if (header.startsWith("BM")) return "image/bmp";
  if (starts(0, 0, 1, 0)) return "image/x-icon";
  if (starts(0x49, 0x49, 42, 0) || starts(0x4d, 0x4d, 0, 42))
    return "image/tiff";
  if (header.slice(4, 8) === "ftyp") {
    const brand = header.slice(8);
    if (["avif", "avis"].includes(brand)) return "image/avif";
    if (["heic", "heix", "hevc", "hevx"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
}

/** 图片读取媒体内容，其他路径只读取属性，正文留给 Agent 工具按需获取。 */
export async function readPathAttachment(
  path: string,
  workspace: WorkspaceEnv,
  options: { image?: boolean } = {},
): Promise<PathAttachment> {
  const extension =
    path.split(/[\\/]/).pop()?.split(".").slice(1).pop()?.toLowerCase() ?? "";
  const extensionType = IMAGE_MEDIA_TYPES.get(extension);
  if (!extensionType && !options.image) {
    let stat = await invoke<{ kind: string; size: number }>("fs_stat", {
      path,
      workspace,
    });
    if (stat.kind === "symlink") {
      const canonical = await invoke<string>("fs_canonicalize", {
        path,
        workspace,
      });
      stat = await invoke<{ kind: string; size: number }>("fs_stat", {
        path: canonical,
        workspace,
      });
    }
    if (stat.kind !== "file") return { kind: "unsupported", size: stat.size };
    return { kind: "file", size: stat.size };
  }
  const binary = await invoke<{ bytes: number[]; size: number }>(
    "fs_read_binary",
    { path, workspace },
  );
  const bytes = new Uint8Array(binary.bytes);
  const mediaType = imageMediaType(bytes) ?? extensionType;
  if (!mediaType) return { kind: "binary", size: binary.size };
  const url = await readAsDataURL(new Blob([bytes], { type: mediaType }));
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
