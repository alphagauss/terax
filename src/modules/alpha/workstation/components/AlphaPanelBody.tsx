/**
 * 面板内容以展开尺寸常驻，折叠仅移动裁剪外壳，不逐帧缩放 Canvas。
 * 业务可见性由面板池管理；本层只负责可取消的展示过渡和隐藏命中区域。
 */
import { RevealMotion } from "@/lib/revealMotion";
import { AlphaPanelHost } from "@/modules/alpha/workstation/components/AlphaPanelPool";
import { ALPHA_PANEL_HEADER_HEIGHT } from "@/modules/alpha/workstation/panelGeometry";
import { useLayoutEffect, useRef } from "react";

type Props = { panelId: string; collapsed: boolean; height: number };

/** 保留内容宿主及展开尺寸，快速反向切换从当前裁剪边界继续。 */
export function AlphaPanelBody({ panelId, collapsed, height }: Props) {
  const shellRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const previousCollapsed = useRef(collapsed);
  const fromHeight = useRef(collapsed ? 0 : height);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!shell || !viewport || !content) return;
    // 旧过渡清理后重新提交外壳占位，内部宿主始终保留展开尺寸。
    shell.style.height = `${collapsed ? 0 : height}px`;
    const changed = previousCollapsed.current !== collapsed;
    previousCollapsed.current = collapsed;
    const toHeight = collapsed ? 0 : height;
    let motion: RevealMotion | null = null;
    let running = false;
    if (collapsed && content.contains(document.activeElement)) {
      shell.parentElement
        ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
        ?.focus();
    }
    if (changed) {
      running = true;
      motion = new RevealMotion(() => {
        running = false;
        fromHeight.current = toHeight;
        shell.style.visibility = collapsed ? "hidden" : "visible";
      }, true);
      shell.style.visibility = "visible";
      motion.style(shell, "height", `${height}px`);
      motion.reveal(viewport, content, {
        fromHeight: Math.min(height, fromHeight.current),
        toHeight,
        contentHeight: height,
      });
      motion.start();
    } else {
      fromHeight.current = toHeight;
      shell.style.visibility = collapsed ? "hidden" : "visible";
    }
    return () => {
      // 只有打断进行中的过渡才测量视觉边界，普通缩放与卸载无需强制布局。
      if (running)
        fromHeight.current = Math.max(
          0,
          Math.min(
            height,
            viewport.getBoundingClientRect().bottom -
              content.getBoundingClientRect().top,
          ),
        );
      motion?.finish(false);
    };
  }, [collapsed, height]);

  return (
    <div
      ref={shellRef}
      className="pointer-events-none absolute left-0 w-full overflow-hidden"
      style={{ top: ALPHA_PANEL_HEADER_HEIGHT, height: collapsed ? 0 : height }}
      inert={collapsed}
      aria-hidden={collapsed}
    >
      <div
        ref={viewportRef}
        className="absolute inset-x-0 top-0 overflow-hidden"
        style={{ height }}
      >
        <div
          ref={contentRef}
          className="border-x border-b border-border bg-background"
          style={{ height, pointerEvents: collapsed ? "none" : "auto" }}
        >
          <AlphaPanelHost panelId={panelId} className="h-full" />
        </div>
      </div>
    </div>
  );
}
