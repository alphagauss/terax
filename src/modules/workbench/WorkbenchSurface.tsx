/**
 * 本文件组合当前 Space 的 Workbench 分组布局与稳定视图池。
 * 标签栏仅作为可隐藏外壳，隐藏时不会卸载编辑器、终端或其他页面实例。
 */

import { tabsForSpace } from "@/modules/workbench/model";
import type { WorkbenchState } from "@/modules/workbench/types";
import type { WorkbenchViewServices } from "@/modules/workbench/viewRegistry";
import {
  type WorkbenchChromeActions,
  WorkbenchGrid,
} from "@/modules/workbench/WorkbenchGrid";
import { WorkbenchViewPool } from "@/modules/workbench/WorkbenchViewPool";
import "@/modules/workbench/workbench.css";

type Props = {
  state: WorkbenchState;
  activeSpaceId: string;
  actions: WorkbenchChromeActions;
  services: WorkbenchViewServices;
  hideTabBars?: boolean;
  visible?: boolean;
};

/** 渲染当前 Space 的稳定 Workbench 视图池和递归分组布局。 */
export function WorkbenchSurface({
  state,
  activeSpaceId,
  actions,
  services,
  hideTabBars = false,
  visible = true,
}: Props) {
  const space = state.spaces[activeSpaceId];
  if (!space) return null;
  const tabs = tabsForSpace(state, activeSpaceId);
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <WorkbenchGrid
        root={space.root}
        groups={space.groups}
        tabs={state.tabs}
        activeGroupId={space.activeGroupId}
        tabCount={tabs.length}
        actions={actions}
        hideTabBars={hideTabBars}
      />
      <WorkbenchViewPool
        state={state}
        tabs={Object.values(state.tabs)}
        activeSpaceId={activeSpaceId}
        services={services}
        visible={visible}
      />
    </div>
  );
}
