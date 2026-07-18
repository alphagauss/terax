import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { TabBar } from "@/modules/tabs";
import {
  useWorkbenchDragSnapshot,
  type WorkbenchDropTarget,
} from "@/modules/workbench/dragSession";
import type {
  Tab,
  WorkbenchDirection,
  WorkbenchGroup as WorkbenchGroupModel,
  WorkbenchLayoutNode,
} from "@/modules/workbench/types";
import { Fragment } from "react";
import type { Layout, LayoutChangedMeta } from "react-resizable-panels";

export type WorkbenchChromeActions = {
  selectTab: (tabId: number) => void;
  activateGroup: (groupId: number) => void;
  newTerminal: (groupId: number) => void;
  newBlock: (groupId: number) => void;
  newPrivate: (groupId: number) => void;
  newPreview: (groupId: number) => void;
  newEditor: (groupId: number) => void;
  newGitGraph: (groupId: number) => void;
  closeTab: (tabId: number) => void;
  pinTab: (tabId: number) => void;
  renameTab: (tabId: number, title: string) => void;
  dropTab: (tabId: number, target: WorkbenchDropTarget) => void;
  splitTab: (
    tabId: number,
    direction: WorkbenchDirection,
    move: boolean,
  ) => void;
  overrideLanguage: (tabId: number, language: string | null) => void;
  resizeSplit: (splitId: number, sizes: number[]) => void;
};

type Props = {
  root: WorkbenchLayoutNode;
  groups: Record<number, WorkbenchGroupModel>;
  tabs: Record<number, Tab>;
  activeGroupId: number;
  tabCount: number;
  actions: WorkbenchChromeActions;
};

export function WorkbenchGrid(props: Props) {
  return <WorkbenchNode node={props.root} {...props} />;
}

function WorkbenchNode({
  node,
  ...props
}: Props & { node: WorkbenchLayoutNode }) {
  if (node.kind === "group") {
    const group = props.groups[node.groupId];
    if (!group) return null;
    return <WorkbenchGroup group={group} {...props} />;
  }

  const panelIds = node.children.map((child) => `workbench-${child.id}`);
  const handleLayout = (layout: Layout, meta: LayoutChangedMeta) => {
    if (!meta.isUserInteraction) return;
    const sizes = panelIds.map((id) => layout[id]);
    if (sizes.every(Number.isFinite)) props.actions.resizeSplit(node.id, sizes);
  };

  return (
    <ResizablePanelGroup
      id={`workbench-split-${node.id}`}
      orientation={node.axis === "row" ? "horizontal" : "vertical"}
      onLayoutChanged={handleLayout}
    >
      {node.children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && <ResizableHandle />}
          <ResizablePanel
            id={panelIds[index]}
            minSize="15%"
            defaultSize={`${node.sizes?.[index] ?? 100 / node.children.length}%`}
          >
            <WorkbenchNode node={child} {...props} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function WorkbenchGroup({
  group,
  tabs,
  activeGroupId,
  tabCount,
  actions,
}: Omit<Props, "root"> & { group: WorkbenchGroupModel }) {
  const groupTabs = group.tabIds
    .map((id) => tabs[id])
    .filter((tab): tab is Tab => tab !== undefined);
  const active = group.id === activeGroupId;
  return (
    <section
      data-workbench-group={group.id}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
      onMouseDownCapture={() => actions.activateGroup(group.id)}
      onFocusCapture={() => actions.activateGroup(group.id)}
    >
      <div className="flex h-9 shrink-0 items-center border-b border-border/60 bg-card px-1.5">
        <TabBar
          groupId={group.id}
          tabs={groupTabs}
          activeId={group.activeTabId}
          activeGroup={active}
          onSelect={actions.selectTab}
          onNew={() => actions.newTerminal(group.id)}
          onNewBlock={() => actions.newBlock(group.id)}
          onNewPrivate={() => actions.newPrivate(group.id)}
          onNewPreview={() => actions.newPreview(group.id)}
          onNewEditor={() => actions.newEditor(group.id)}
          onNewGitGraph={() => actions.newGitGraph(group.id)}
          onClose={actions.closeTab}
          onPin={actions.pinTab}
          onRename={actions.renameTab}
          onDropTab={actions.dropTab}
          onSplitTab={actions.splitTab}
          canClose={tabCount > 1}
          onOverrideLanguage={actions.overrideLanguage}
          compact
        />
      </div>
      <div
        data-workbench-drop-surface={group.id}
        className="relative min-h-0 flex-1 overflow-hidden"
      >
        <div
          data-workbench-view-host={group.id}
          className="absolute inset-0 overflow-hidden"
        />
        <WorkbenchDropOverlay groupId={group.id} />
      </div>
    </section>
  );
}

function WorkbenchDropOverlay({ groupId }: { groupId: number }) {
  const target = useWorkbenchDragSnapshot().target;
  if (target?.kind !== "group" || target.groupId !== groupId) return null;
  const geometry = {
    center: { top: "0", left: "0", width: "100%", height: "100%" },
    left: { top: "0", left: "0", width: "50%", height: "100%" },
    right: { top: "0", left: "50%", width: "50%", height: "100%" },
    up: { top: "0", left: "0", width: "100%", height: "50%" },
    down: { top: "50%", left: "0", width: "100%", height: "50%" },
  }[target.zone];
  return (
    <div
      data-workbench-drop-indicator={target.zone}
      className="workbench-drop-indicator pointer-events-none absolute z-40 bg-primary/18"
      style={geometry}
    />
  );
}
