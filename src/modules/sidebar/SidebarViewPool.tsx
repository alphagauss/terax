/**
 * 本文件为已激活的侧边栏容器提供稳定 React 和 DOM 所有权。
 * 普通切换只改变可见性，只有跨位置移动时才重挂宿主节点。
 */

import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { findSidebarContainerLocation } from "./model";
import type {
  SidebarContainerId,
  SidebarPlacements,
  SidebarRuntimeState,
} from "./types";

export type SidebarPooledView = {
  id: SidebarContainerId;
  content: ReactNode;
};

type Props = {
  views: readonly SidebarPooledView[];
  placements: SidebarPlacements;
  runtime: SidebarRuntimeState;
  temporarilyHidden: boolean;
};

/** 按需挂载侧边栏容器，并在两个位置宿主之间保留其实例。 */
export function SidebarViewPool({
  views,
  placements,
  runtime,
  temporarilyHidden,
}: Props) {
  const activatedRef = useRef(new Set<SidebarContainerId>());

  return (
    <>
      {views.map((view) => {
        const location = findSidebarContainerLocation(placements, view.id);
        const visible =
          !temporarilyHidden &&
          (runtime.secondaryMode !== "maximized" || location === "secondary") &&
          runtime[location].activeId === view.id &&
          !runtime[location].collapsed;
        if (visible) activatedRef.current.add(view.id);
        if (!activatedRef.current.has(view.id)) return null;
        return (
          <PooledSidebarView
            key={view.id}
            view={view}
            location={location}
            visible={visible}
          />
        );
      })}
    </>
  );
}

function PooledSidebarView({
  view,
  location,
  visible,
}: {
  view: SidebarPooledView;
  location: "primary" | "secondary";
  visible: boolean;
}) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "absolute top-0 left-0";
    element.dataset.sidebarView = view.id;
    return element;
  });

  useLayoutEffect(() => {
    const host = document.querySelector<HTMLElement>(
      `[data-sidebar-view-host="${location}"]`,
    );
    if (host && container.parentNode !== host) {
      host.appendChild(container);
    }
    container.style.visibility = visible ? "visible" : "hidden";
    container.style.pointerEvents = visible ? "auto" : "none";
    container.inert = !visible;
    container.setAttribute("aria-hidden", String(!visible));
    if (!visible || !host) return;
    // 使用未缩放的布局尺寸，隐藏时冻结，避免零宽重排和应用缩放被重复计算。
    const updateSize = () => {
      const { clientWidth: width, clientHeight: height } = host;
      if (width <= 0 || height <= 0) return;
      container.style.width = `${width}px`;
      container.style.height = `${height}px`;
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(host);
    return () => observer.disconnect();
  }, [container, location, visible]);

  useEffect(
    () => () => {
      container.remove();
    },
    [container],
  );

  return createPortal(
    <div className="relative h-full w-full">{view.content}</div>,
    container,
  );
}
