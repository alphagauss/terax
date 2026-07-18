import { findGroupForTab } from "@/modules/workbench/model";
import type {
  Tab,
  WorkbenchLayoutNode,
  WorkbenchState,
} from "@/modules/workbench/types";
import {
  WorkbenchRegisteredView,
  type WorkbenchViewServices,
} from "@/modules/workbench/viewRegistry";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

type Props = {
  state: WorkbenchState;
  tabs: Tab[];
  activeSpaceId: string;
  services: WorkbenchViewServices;
};

export function WorkbenchViewPool({
  state,
  tabs,
  activeSpaceId,
  services,
}: Props) {
  const depotRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={depotRef} className="hidden" aria-hidden />
      {tabs.map((tab) => {
        const owner = findGroupForTab(state, tab.id);
        if (!owner) return null;
        const group = owner.group;
        const visible =
          owner.spaceId === activeSpaceId && group.activeTabId === tab.id;
        const focused =
          visible && state.spaces[activeSpaceId]?.activeGroupId === group.id;
        return (
          <PooledView
            key={tab.id}
            tab={tab}
            groupId={group.id}
            layoutRoot={state.spaces[owner.spaceId].root}
            visible={visible}
            focused={focused}
            depotRef={depotRef}
            services={services}
          />
        );
      })}
    </>
  );
}

type PooledViewProps = {
  tab: Tab;
  groupId: number;
  layoutRoot: WorkbenchLayoutNode;
  visible: boolean;
  focused: boolean;
  depotRef: RefObject<HTMLDivElement | null>;
  services: WorkbenchViewServices;
};

function PooledView({
  tab,
  groupId,
  layoutRoot,
  visible,
  focused,
  depotRef,
  services,
}: PooledViewProps) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.className = "absolute inset-0";
    element.dataset.workbenchTab = String(tab.id);
    return element;
  });

  useLayoutEffect(() => {
    // A split replaces host elements even when this tab keeps the same group.
    void layoutRoot;
    const host = document.querySelector<HTMLElement>(
      `[data-workbench-view-host="${groupId}"]`,
    );
    const target = host ?? depotRef.current;
    if (target && container.parentNode !== target)
      target.appendChild(container);
    container.style.visibility = visible ? "visible" : "hidden";
    container.style.pointerEvents = visible ? "auto" : "none";
    container.inert = !visible;
    container.setAttribute("aria-hidden", String(!visible));
  }, [container, depotRef, groupId, layoutRoot, visible]);

  useEffect(
    () => () => {
      container.remove();
    },
    [container],
  );

  return createPortal(
    <div
      className="relative h-full w-full"
      onMouseDownCapture={() => services.onFocusTab(tab.id)}
      onFocusCapture={() => services.onFocusTab(tab.id)}
    >
      <WorkbenchRegisteredView
        tab={tab}
        visible={visible}
        focused={focused}
        services={services}
      />
    </div>,
    container,
  );
}
