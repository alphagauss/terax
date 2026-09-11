/** 工作区资源拖放目标注册；命中目标后由目标处理，禁止继续触发文件移动。 */
export type ResourceDropTarget = {
  element: HTMLElement;
  hover: (active: boolean) => void;
  drop: (path: string) => void;
};

const targets = new Set<ResourceDropTarget>();

export function registerResourceDropTarget(
  target: ResourceDropTarget,
): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}

export function resourceDropTargetAt(
  x: number,
  y: number,
): ResourceDropTarget | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  for (const target of targets) {
    if (target.element.contains(hit)) return target;
  }
  return null;
}

export function finishResourceDrop(
  target: ResourceDropTarget,
  path: string,
  commit: boolean,
): void {
  if (commit && targets.has(target)) target.drop(path);
}
