import type {
  SidebarContainerDefinition,
  SidebarContainerId,
  SidebarLocationRuntime,
} from "@/modules/sidebar/types";
import type { Tab } from "@/modules/workbench";

/** 主活动栏优先反映展开的侧栏，收起后按入口声明匹配当前工作页。 */
export function getPrimaryNavigationActiveId(
  primary: Pick<SidebarLocationRuntime, "activeId" | "collapsed">,
  activeTabKind: Tab["kind"] | undefined,
  containers: readonly SidebarContainerDefinition[],
): SidebarContainerId | null {
  if (!primary.collapsed) return primary.activeId;
  if (!activeTabKind) return null;
  return (
    containers.find((container) => container.opensPage === activeTabKind)?.id ??
    null
  );
}
