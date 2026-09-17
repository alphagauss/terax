/**
 * 本文件实现资源管理器内部及到 Workbench 的指针拖放。
 * 通过容器事件委托和直接更新拖动指示器，避免拖动期间逐帧触发 React 渲染。
 */

import {
  resourceDropTargetAt,
  finishResourceDrop,
  type ResourceDropTarget,
} from "@/modules/file-actions/resourceDrop";
import {
  beginWorkbenchDrag,
  finishWorkbenchDrag,
  updateWorkbenchDrag,
  type WorkbenchDropTarget,
} from "@/modules/workbench/dragSession";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { parentDirectory } from "@/modules/filesystem";

type Options = {
  rootPath: string;
  isDir: (path: string) => boolean | undefined;
  onMove: (from: string, toDir: string) => void;
  onDropToWorkbench?: (path: string, target: WorkbenchDropTarget) => void;
};

const THRESHOLD = 5;

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
      let resourceTarget: ResourceDropTarget | null = null;

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
        const nextResourceTarget = sourceIsFile
          ? resourceDropTargetAt(ev.clientX, ev.clientY)
          : null;
        if (nextResourceTarget !== resourceTarget) {
          resourceTarget?.hover(false);
          resourceTarget = nextResourceTarget;
          resourceTarget?.hover(true);
        }
        const workbenchTarget = sourceIsFile
          ? updateWorkbenchDrag(
              resourceTarget ? -1 : ev.clientX,
              resourceTarget ? -1 : ev.clientY,
            )
          : null;
        const { rootPath, isDir } = optsRef.current;
        const pointerHit = document.elementFromPoint(ev.clientX, ev.clientY);
        const hit = pointerHit?.closest<HTMLElement>("[data-fs-path]");
        const p = hit?.getAttribute("data-fs-path");
        const kind = p ? isDir(p) : undefined;
        let target: string | null = pointerHit?.closest("[data-explorer-drop]")
          ? rootPath
          : null;
        if (p && kind === true) target = p;
        else if (p && kind === false) target = parentDirectory(p);
        else if (p) target = null;
        const valid =
          !resourceTarget &&
          !workbenchTarget &&
          target !== null &&
          target !== source &&
          !target.startsWith(`${source}/`) &&
          parentDirectory(source) !== target
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
        resourceTarget?.hover(false);
        cleanupRef.current = null;
      };
      const end = (commit: boolean) => {
        detach();
        if (!active) return;
        const droppedOnResource = resourceTarget !== null;
        if (resourceTarget) finishResourceDrop(resourceTarget, source, commit);
        resourceTarget = null;
        const droppedInWorkbench = ownsWorkbenchDragRef.current
          ? finishWorkbenchDrag(commit)
          : false;
        ownsWorkbenchDragRef.current = false;
        if (
          commit &&
          !droppedOnResource &&
          !droppedInWorkbench &&
          dropTargetRef.current
        )
          optsRef.current.onMove(source, dropTargetRef.current);
        suppressClickRef.current = true;
        setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
        dropTargetRef.current = null;
        setDragLabel(null);
        setDropTargetDir(null);
      };
      const up = (ev: PointerEvent) => {
        // 松开前可能没有最后一次移动事件，提交必须按实际落点重新命中。
        if (active) move(ev);
        end(true);
      };
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
