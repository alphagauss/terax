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
};

export function WorkbenchSurface({
  state,
  activeSpaceId,
  actions,
  services,
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
      />
      <WorkbenchViewPool
        state={state}
        tabs={Object.values(state.tabs)}
        activeSpaceId={activeSpaceId}
        services={services}
      />
    </div>
  );
}
