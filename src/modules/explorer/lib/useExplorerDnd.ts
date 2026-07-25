/**
 * 本文件实现资源管理器内部及到 Workbench 的指针拖放。
 * 通过容器事件委托和直接更新拖动指示器，避免拖动期间逐帧触发 React 渲染。
 */

import {
  beginWorkbenchDrag,
  finishWorkbenchDrag,
  updateWorkbenchDrag,
  type WorkbenchDropTarget,
} from "@/modules/workbench/dragSession";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

type Options = {
  rootPath: string;
  isDir: (path: string) => boolean | undefined;
  onMove: (from: string, toDir: string) => void;
  onDropToWorkbench?: (path: string, target: WorkbenchDropTarget) => void;
};

const THRESHOLD = 5;

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

/**
 * 管理资源管理器的指针拖放会话。
 *
 * `isDir` 返回 `undefined` 的条目不可作为拖动来源或目标，用于锁定删除中的路径。
 */
export function useExplorerDnd({
  rootPath,
  isDir,
  onMove,
  onDropToWorkbench,
}: Options) {
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const [dropTargetDir, setDropTargetDir] = useState<string | null>(null);

  const ghostElRef = useRef<HTMLDivElement | null>(null);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const dropTargetRef = useRef<string | null>(null);
  const suppressClickRef = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const ownsWorkbenchDragRef = useRef(false);
  const optsRef = useRef({ rootPath, isDir, onMove, onDropToWorkbench });
  optsRef.current = { rootPath, isDir, onMove, onDropToWorkbench };

  const placeGhost = useCallback((x: number, y: number) => {
    lastPosRef.current = { x, y };
    const g = ghostElRef.current;
    if (g) {
      g.style.left = `${x + 12}px`;
      g.style.top = `${y + 8}px`;
    }
  }, []);

  const ghostRef = useCallback(
    (el: HTMLDivElement | null) => {
      ghostElRef.current = el;
      if (el) placeGhost(lastPosRef.current.x, lastPosRef.current.y);
    },
    [placeGhost],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (e.button !== 0) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-fs-path]",
      );
      const source = el?.getAttribute("data-fs-path");
      if (!source) return;
      const sourceKind = optsRef.current.isDir(source);
      if (sourceKind === undefined) return;
      const name = source.slice(source.lastIndexOf("/") + 1);
      const sx = e.clientX;
      const sy = e.clientY;
      const sourceIsFile = sourceKind === false;
      let active = false;

      const move = (ev: PointerEvent) => {
        if (!active) {
          if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < THRESHOLD) return;
          active = true;
          lastPosRef.current = { x: ev.clientX, y: ev.clientY };
          setDragLabel(name);
          if (sourceIsFile && optsRef.current.onDropToWorkbench) {
            beginWorkbenchDrag(
              { kind: "resource", path: source },
              (payload, target) => {
                if (payload.kind === "resource") {
                  optsRef.current.onDropToWorkbench?.(payload.path, target);
                }
              },
            );
            ownsWorkbenchDragRef.current = true;
          }
        }
        placeGhost(ev.clientX, ev.clientY);
        const workbenchTarget = sourceIsFile
          ? updateWorkbenchDrag(ev.clientX, ev.clientY)
          : null;
        const { rootPath, isDir } = optsRef.current;
        const hit = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>("[data-fs-path]");
        const p = hit?.getAttribute("data-fs-path");
        const kind = p ? isDir(p) : undefined;
        let target: string | null = rootPath;
        if (p && kind === true) target = p;
        else if (p && kind === false) target = parentDir(p);
        else if (p) target = null;
        const valid =
          !workbenchTarget &&
          target !== null &&
          target !== source &&
          !target.startsWith(`${source}/`) &&
          parentDir(source) !== target
            ? target
            : null;
        if (dropTargetRef.current !== valid) {
          dropTargetRef.current = valid;
          setDropTargetDir(valid);
        }
      };
      const detach = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        cleanupRef.current = null;
      };
      const end = (commit: boolean) => {
        detach();
        if (!active) return;
        const droppedInWorkbench = ownsWorkbenchDragRef.current
          ? finishWorkbenchDrag(commit)
          : false;
        ownsWorkbenchDragRef.current = false;
        if (commit && !droppedInWorkbench && dropTargetRef.current)
          optsRef.current.onMove(source, dropTargetRef.current);
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        dropTargetRef.current = null;
        setDragLabel(null);
        setDropTargetDir(null);
      };
      const up = () => end(true);
      const cancel = () => end(false);
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      cleanupRef.current = detach;
    },
    [placeGhost],
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      if (ownsWorkbenchDragRef.current) finishWorkbenchDrag(false);
      ownsWorkbenchDragRef.current = false;
    },
    [],
  );

  return { ghostRef, dragLabel, dropTargetDir, onPointerDown, onClickCapture };
}
