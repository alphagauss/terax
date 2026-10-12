/**
 * 本文件实现 Markdown 图片的按需加载与上下文操作。
 *
 * 图片接近预览滚动区域后才准备资源；同一文档只订阅一次工作区环境。
 */

import { writeClipboardImage, savePreparedImage } from "@/lib/imageActions";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/menu/context-menu";
import {
  isNetworkMarkdownImageSource,
  type MarkdownImageSource,
  useMarkdownImageAsset,
} from "@/modules/markdown/lib/imageResources";
import {
  decodeRelativeMarkdownImage,
  resolveMarkdownImagePath,
} from "@/modules/markdown/lib/localImages";
import { useWorkspaceEnvStore, type WorkspaceEnv } from "@/modules/workspace";
import { Copy01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { reportError } from "@/lib/errors";

type MarkdownImageContextValue = {
  documentPath: string;
  scrollRoot: HTMLElement | null;
  visible: boolean;
  workspace: WorkspaceEnv;
};

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & {
  node?: unknown;
};

const MarkdownImageContext = createContext<MarkdownImageContextValue>({
  documentPath: "",
  scrollRoot: null,
  visible: true,
  workspace: { kind: "local" },
});
type ImageObserverState = {
  observer: IntersectionObserver;
  targets: Map<Element, () => void>;
};
const imageObservers = new Map<Element | null, ImageObserverState>();

/** 每个预览滚动容器共享一个观察器，并在最后一张图片离开时立即释放。 */
function observeImageNearViewport(
  root: HTMLElement | null,
  element: Element,
  activate: () => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    activate();
    return () => {};
  }

  let state = imageObservers.get(root);
  if (!state) {
    const targets = new Map<Element, () => void>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const callback = targets.get(entry.target);
          if (!callback) continue;
          targets.delete(entry.target);
          observer.unobserve(entry.target);
          callback();
        }
        if (targets.size === 0) {
          observer.disconnect();
          if (imageObservers.get(root)?.observer === observer) {
            imageObservers.delete(root);
          }
        }
      },
      { root, rootMargin: "800px 0px" },
    );
    state = { observer, targets };
    imageObservers.set(root, state);
  }

  state.targets.set(element, activate);
  state.observer.observe(element);
  return () => {
    const current = imageObservers.get(root);
    if (!current) return;
    current.targets.delete(element);
    current.observer.unobserve(element);
    if (current.targets.size === 0) {
      current.observer.disconnect();
      imageObservers.delete(root);
    }
  };
}

/** 为当前 Markdown 文档提供图片路径和标签页可见状态。 */
export function MarkdownImageProvider({
  documentPath,
  scrollRoot = null,
  visible,
  children,
}: Pick<MarkdownImageContextValue, "documentPath" | "visible"> & {
  scrollRoot?: HTMLElement | null;
  children?: ReactNode;
}) {
  const workspace = useWorkspaceEnvStore((state) => state.env);
  const value = useMemo(
    () => ({ documentPath, scrollRoot, visible, workspace }),
    [documentPath, scrollRoot, visible, workspace],
  );
  return (
    <MarkdownImageContext.Provider value={value}>
      {children}
    </MarkdownImageContext.Provider>
  );
}

/** 渲染普通网络图片，或按视口和工作区环境加载相对图片。 */
export function MarkdownPreviewImage({
  src,
  srcSet,
  alt,
  node: _node,
  ...props
}: MarkdownImageProps) {
  const { t } = useTranslation("markdown");
  const { documentPath, scrollRoot, visible, workspace } =
    useContext(MarkdownImageContext);
  const imageRef = useRef<HTMLImageElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const relativeSource =
    typeof src === "string" ? decodeRelativeMarkdownImage(src) : null;
  const resolvedPath =
    relativeSource === null
      ? null
      : resolveMarkdownImagePath(documentPath, relativeSource);
  const networkSource =
    typeof src === "string" && isNetworkMarkdownImageSource(src) ? src : null;
  const source = useMemo<MarkdownImageSource | null>(() => {
    if (resolvedPath) {
      return { kind: "workspace", path: resolvedPath, workspace };
    }
    if (networkSource) {
      return {
        kind: "network",
        url: networkSource,
        userAgent: navigator.userAgent,
      };
    }
    return null;
  }, [networkSource, resolvedPath, workspace]);

  useEffect(() => {
    if (!source || !visible || nearViewport) {
      return;
    }
    const image = imageRef.current;
    if (!image) return;
    return observeImageNearViewport(scrollRoot, image, () =>
      setNearViewport(true),
    );
  }, [nearViewport, scrollRoot, source, visible]);

  const asset = useMarkdownImageAsset(source, Boolean(source && nearViewport));
  const renderedSource = source
    ? (asset.url ?? undefined)
    : relativeSource === null
      ? src
      : undefined;
  const image = (
    <img
      {...props}
      ref={imageRef}
      src={renderedSource}
      srcSet={source || relativeSource !== null ? undefined : srcSet}
      crossOrigin={source ? "anonymous" : undefined}
      alt={alt ?? ""}
      loading="lazy"
      decoding="async"
      data-markdown-relative-image={
        relativeSource === null ? undefined : "true"
      }
      data-markdown-image-state={
        !source
          ? undefined
          : asset.error
            ? "error"
            : asset.url
              ? "ready"
              : "pending"
      }
    />
  );

  if (!source) return image;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{image}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem
          disabled={!asset.resource}
          onSelect={() => {
            const element = imageRef.current;
            if (!element) return;
            void writeClipboardImage(element)
              .then(() => toast.success(t("imageCopied")))
              .catch((error) =>
                reportError(t("imageCopyFailed", { message: String(error) }), {
                  error,
                }),
              );
          }}
        >
          <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={2} />
          {t("copyImage")}
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!asset.resource}
          onSelect={() => {
            if (!asset.resource) return;
            void savePreparedImage(asset.resource, {
              title: t("saveImage"),
              imageFilter: t("imageFile"),
            })
              .then((saved) => {
                if (saved) toast.success(t("imageSaved"));
              })
              .catch((error) =>
                reportError(t("imageSaveFailed", { message: String(error) }), {
                  error,
                }),
              );
          }}
        >
          <HugeiconsIcon icon={Download01Icon} size={13} strokeWidth={2} />
          {t("saveImage")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
