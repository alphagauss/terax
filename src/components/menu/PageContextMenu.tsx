/** 应用页面的补缺菜单；已有业务菜单优先，编辑区域和嵌入网页继续使用各自菜单。 */
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "@/components/menu/context-menu";
import { writeClipboardHtml, writeClipboardText } from "@/lib/clipboard";
import { writeClipboardImage, saveImageAs } from "@/lib/imageActions";
import { capturePageSelection } from "@/lib/selectionClipboard";

type Target = {
  selection: ReturnType<typeof capturePageSelection>;
  image: { element: HTMLImageElement; src: string } | null;
  href: string | null;
  container: HTMLElement | null;
};

/** 在冒泡阶段补齐菜单，并在打开时保存复制目标，避免菜单焦点改变原选区。 */
export function PageContextMenu() {
  const { t } = useTranslation("common");
  const trigger = useRef<HTMLSpanElement>(null);
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        !(event.target instanceof Element) ||
        event.target === trigger.current
      )
        return;
      const element = event.target;
      if (
        element.closest(
          "input, textarea, [contenteditable]:not([contenteditable='false']), .cm-editor, .xterm, [role='menu']",
        )
      )
        return;
      const image = element.closest("img");
      const link = element.closest("a[href]");
      const selection = window.getSelection();
      const intersects =
        selection &&
        Array.from({ length: selection.rangeCount }, (_, i) =>
          selection.getRangeAt(i),
        ).some((range) => range.intersectsNode(element));
      const snapshot = {
        selection: intersects ? capturePageSelection() : null,
        image: image
          ? { element: image, src: image.currentSrc || image.src }
          : null,
        href: link instanceof HTMLAnchorElement ? link.href : null,
        container: element.closest<HTMLElement>('[role="dialog"]'),
      };
      if (intersects && selection?.toString() && !snapshot.selection) return;
      // 普通空白处没有可用动作，不弹出浏览器的通用页面菜单。
      event.preventDefault();
      if (!snapshot.selection && !snapshot.image && !snapshot.href) return;
      setTarget(snapshot);
      // 复用 Radix 的定位、键盘导航和关闭行为，不维护第二套菜单状态机。
      trigger.current?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: event.clientX,
          clientY: event.clientY,
        }),
      );
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const copy = (action: () => Promise<void>) => {
    void action()
      .then(() => toast.success(t("copied")))
      .catch(() => toast.error(t("pageMenu.copyFailed")));
  };
  const selection = target?.selection;
  const image = target?.image;
  const href = target?.href;
  return (
    <ContextMenu
      modal={false}
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
    >
      <ContextMenuTrigger asChild>
        <span
          ref={trigger}
          aria-hidden="true"
          className="pointer-events-none fixed h-0 w-0"
        />
      </ContextMenuTrigger>
      <ContextMenuContent portalContainer={target?.container ?? undefined}>
        {selection && (
          <ContextMenuItem
            onSelect={() => {
              const { html, text } = selection;
              copy(() => writeClipboardHtml(html, text));
            }}
          >
            {t("copy")}
          </ContextMenuItem>
        )}
        {image && (
          <ContextMenuItem
            disabled={!image.element.complete || !image.element.naturalWidth}
            onSelect={() => {
              const { element, src } = image;
              copy(async () => {
                if (
                  !element.isConnected ||
                  (element.currentSrc || element.src) !== src
                )
                  throw new Error("image changed");
                await writeClipboardImage(element);
              });
            }}
          >
            {t("pageMenu.copyImage")}
          </ContextMenuItem>
        )}
        {image && (
          <ContextMenuItem
            onSelect={() => {
              void saveImageAs(image.src, {
                title: t("pageMenu.saveImage"),
                imageFilter: t("pageMenu.imageFilter"),
              })
                .then((saved) => {
                  if (saved) toast.success(t("pageMenu.saved"));
                })
                .catch(() => toast.error(t("pageMenu.saveFailed")));
            }}
          >
            {t("pageMenu.saveImage")}
          </ContextMenuItem>
        )}
        {href && (
          <ContextMenuItem
            onSelect={() => copy(() => writeClipboardText(href))}
          >
            {t("pageMenu.copyLink")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
