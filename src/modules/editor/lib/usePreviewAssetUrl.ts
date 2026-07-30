/**
 * 本文件为编辑器媒体预览提供跨工作区资源 URL。
 *
 * Local 使用零拷贝 asset URL，WSL 先解析宿主路径，SSH 使用受大小限制的 object URL。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type BinaryReadResult = {
  bytes: number[];
  size: number;
};

export type PreviewMediaKind = "image" | "video" | "audio" | "pdf";

type PreviewAsset = {
  url: string | null;
  error: string | null;
};

const MIME_TYPES: Record<string, string> = {
  avif: "image/avif",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  ogg: "video/ogg",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  pdf: "application/pdf",
};

export function previewMediaKind(path: string): PreviewMediaKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (
    ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif"].includes(ext)
  ) {
    return "image";
  }
  if (["mp4", "webm", "ogg", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "aac", "m4a"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return null;
}

/** 按需创建可供 WebView 加载的媒体 URL，并在远端资源卸载时释放 object URL。 */
export function usePreviewAssetUrl(
  path: string,
  workspace: WorkspaceEnv,
  enabled: boolean,
): PreviewAsset {
  const deferredKey =
    enabled && workspace.kind !== "local"
      ? workspace.kind === "ssh"
        ? `ssh:${workspace.profileId}\u0000${path}`
        : `wsl:${workspace.distro}\u0000${path}`
      : null;
  const [deferredAsset, setDeferredAsset] = useState<
    (PreviewAsset & { key: string }) | null
  >(null);

  useEffect(() => {
    if (!deferredKey || workspace.kind === "local") return;
    let disposed = false;
    let objectUrl: string | null = null;
    const load =
      workspace.kind === "ssh"
        ? invoke<BinaryReadResult>("fs_read_binary", {
            path,
            workspace,
          }).then((result) => {
            const ext = path.split(".").pop()?.toLowerCase() ?? "";
            objectUrl = URL.createObjectURL(
              new Blob([new Uint8Array(result.bytes)], {
                type: MIME_TYPES[ext] ?? "application/octet-stream",
              }),
            );
            return objectUrl;
          })
        : invoke<string>("fs_canonicalize", { path, workspace }).then(
            convertFileSrc,
          );

    void load
      .then((result) => {
        if (disposed) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        setDeferredAsset({ key: deferredKey, url: result, error: null });
      })
      .catch((error) => {
        if (!disposed) {
          setDeferredAsset({
            key: deferredKey,
            url: null,
            error: String(error),
          });
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setDeferredAsset((current) =>
        current?.key === deferredKey ? null : current,
      );
    };
  }, [deferredKey, path, workspace]);

  if (!enabled) return { url: null, error: null };
  if (workspace.kind === "local") {
    return { url: convertFileSrc(path), error: null };
  }
  if (deferredAsset?.key === deferredKey) return deferredAsset;
  return { url: null, error: null };
}
