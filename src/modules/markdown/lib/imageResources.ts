/**
 * 本文件连接 Markdown 图片组件与原生图片资源生命周期。
 *
 * 资源仅在接近视口时准备；组件卸载会释放引用，SSH 与网络临时文件由 Rust 删除。
 */

import type { WorkspaceEnv } from "@/modules/workspace";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export type MarkdownImageSource =
  | {
      kind: "workspace";
      path: string;
      workspace: WorkspaceEnv;
    }
  | {
      kind: "network";
      url: string;
      userAgent: string;
    };

export type PreparedMarkdownImage = {
  token: string;
  path: string;
};

export type MarkdownImageAsset = {
  resource: PreparedMarkdownImage | null;
  url: string | null;
  error: string | null;
};

type SharedMarkdownImage = {
  refs: number;
  promise: Promise<PreparedMarkdownImage>;
};

const sharedImages = new Map<string, SharedMarkdownImage>();

/** 判断 URL 是否属于需要通过受控下载器准备的公开网络图片。 */
export function isNetworkMarkdownImageSource(src: string): boolean {
  return /^https?:\/\//i.test(src);
}

/** 合并同一 WebView 内的重复准备请求，并为 React Strict Mode 保留短暂复用窗口。 */
function acquireSharedImage(
  key: string,
  source: MarkdownImageSource,
): SharedMarkdownImage {
  let shared = sharedImages.get(key);
  if (!shared) {
    const created: SharedMarkdownImage = {
      refs: 0,
      promise: invoke<PreparedMarkdownImage>("markdown_image_prepare", {
        source,
      }),
    };
    sharedImages.set(key, created);
    void created.promise.catch(() => {
      if (sharedImages.get(key) === created) sharedImages.delete(key);
    });
    shared = created;
  }
  shared.refs += 1;
  return shared;
}

/** 在最后一个使用者离开后释放原生资源；微任务延迟可吸收 Strict Mode 的同步重挂载。 */
function releaseSharedImage(key: string, shared: SharedMarkdownImage): void {
  shared.refs = Math.max(0, shared.refs - 1);
  if (shared.refs > 0) return;

  queueMicrotask(() => {
    if (shared.refs > 0 || sharedImages.get(key) !== shared) return;
    sharedImages.delete(key);
    void shared.promise.then(
      (resource) =>
        invoke("markdown_image_release", { token: resource.token }).catch(
          (error) => console.error("[markdown-image] release failed", error),
        ),
      () => {},
    );
  });
}

/** 按需准备图片，并保证每个成功的 prepare 都有对应的 release。 */
export function useMarkdownImageAsset(
  source: MarkdownImageSource | null,
  enabled: boolean,
): MarkdownImageAsset {
  const key = enabled && source ? sourceKey(source) : null;
  const [result, setResult] = useState<
    | {
        key: string;
        resource: PreparedMarkdownImage | null;
        error: string | null;
      }
    | undefined
  >();

  useEffect(() => {
    if (!key || !source) return;
    let disposed = false;
    const shared = acquireSharedImage(key, source);

    void shared.promise
      .then((prepared) => {
        if (disposed) return;
        setResult({ key, resource: prepared, error: null });
      })
      .catch((error) => {
        if (!disposed) {
          setResult({ key, resource: null, error: String(error) });
        }
      });

    return () => {
      disposed = true;
      setResult((current) => (current?.key === key ? undefined : current));
      releaseSharedImage(key, shared);
    };
  }, [key, source]);

  if (!key || result?.key !== key) {
    return { resource: null, url: null, error: null };
  }
  return {
    resource: result.resource,
    url: result.resource ? convertFileSrc(result.resource.path) : null,
    error: result.error,
  };
}

/** 生成仅在当前 WebView 内使用的资源共享键。 */
function sourceKey(source: MarkdownImageSource): string {
  if (source.kind === "network") return `network:${source.url}`;
  const scope =
    source.workspace.kind === "ssh"
      ? `ssh:${source.workspace.profileId}`
      : source.workspace.kind === "wsl"
        ? `wsl:${source.workspace.distro}`
        : "local";
  return `${scope}\0${source.path}`;
}
