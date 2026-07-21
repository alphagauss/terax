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
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) {
    return "image";
  }
  if (["mp4", "webm", "ogg", "mov"].includes(ext)) return "video";
  if (["mp3", "wav", "flac", "aac", "m4a"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  return null;
}

export function usePreviewAssetUrl(
  path: string,
  workspace: WorkspaceEnv,
  enabled: boolean,
): PreviewAsset {
  const remoteKey =
    enabled && workspace.kind === "ssh"
      ? `${workspace.profileId}\u0000${path}`
      : null;
  const [remoteAsset, setRemoteAsset] = useState<
    (PreviewAsset & { key: string }) | null
  >(null);

  useEffect(() => {
    if (!remoteKey || workspace.kind !== "ssh") return;
    let disposed = false;
    let objectUrl: string | null = null;
    const ext = path.split(".").pop()?.toLowerCase() ?? "";

    void invoke<BinaryReadResult>("fs_read_binary", {
      path,
      workspace,
    })
      .then((result) => {
        objectUrl = URL.createObjectURL(
          new Blob([new Uint8Array(result.bytes)], {
            type: MIME_TYPES[ext] ?? "application/octet-stream",
          }),
        );
        if (disposed) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setRemoteAsset({ key: remoteKey, url: objectUrl, error: null });
      })
      .catch((error) => {
        if (!disposed) {
          setRemoteAsset({ key: remoteKey, url: null, error: String(error) });
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, remoteKey, workspace]);

  if (!enabled) return { url: null, error: null };
  if (workspace.kind !== "ssh") {
    return { url: convertFileSrc(path), error: null };
  }
  if (remoteAsset?.key === remoteKey) return remoteAsset;
  return { url: null, error: null };
}
