import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import type { SearchAddon } from "@xterm/addon-search";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useTerminalDropStore } from "./lib/dropStore";
import { leafIds, type PaneNode } from "./lib/panes";
import { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";

type LeafBundle = {
  setRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onExit: (leafId: number, code: number) => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  blocks: boolean;
  onFocusLeaf: (leafId: number) => void;
  onSplitPane: (leafId: number, dir: "row" | "col", before: boolean) => void;
  onClosePane: (leafId: number) => void;
  canSplit: boolean;
  splitDisabledReason: string | null;
  getBundle: (leafId: number) => LeafBundle;
};

export function PaneTreeView(props: Props) {
  const { node } = props;
  if (node.kind === "leaf") {
    const {
      tabVisible,
      activeLeafId,
      onFocusLeaf,
      onSplitPane,
      onClosePane,
      canSplit,
      splitDisabledReason,
      getBundle,
    } = props;
    const focused = node.id === activeLeafId;
    const b = getBundle(node.id);
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: This wrapper synchronizes pane focus with the active leaf. */}
          <div
            onMouseDownCapture={() => {
              if (!focused) onFocusLeaf(node.id);
            }}
            // Catches focus from Tab, programmatic focus, or any path that
            // skips mousedown — keeps activeLeafId in sync with DOM focus.
            onFocus={() => {
              if (!focused) onFocusLeaf(node.id);
            }}
            data-pane-leaf={node.id}
            className="relative h-full w-full"
          >
            <TerminalPane
              leafId={node.id}
              visible={tabVisible}
              focused={focused}
              initialCwd={node.cwd}
              blocks={props.blocks}
              ref={b.setRef}
              onSearchReady={b.onSearchReady}
              onCwd={b.onCwd}
              onExit={b.onExit}
            />
            <DropOverlay leafId={node.id} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="min-w-44 rounded-2xl p-1">
          <ContextMenuItem
            className="rounded-xl px-2.5 py-1.5 text-xs gap-2"
            disabled={!canSplit}
            onSelect={() => onSplitPane(node.id, "col", true)}
          >
            Split Up
          </ContextMenuItem>
          <ContextMenuItem
            className="rounded-xl px-2.5 py-1.5 text-xs gap-2"
            disabled={!canSplit}
            onSelect={() => onSplitPane(node.id, "col", false)}
          >
            Split Down
          </ContextMenuItem>
          <ContextMenuItem
            className="rounded-xl px-2.5 py-1.5 text-xs gap-2"
            disabled={!canSplit}
            onSelect={() => onSplitPane(node.id, "row", true)}
          >
            Split Left
          </ContextMenuItem>
          <ContextMenuItem
            className="rounded-xl px-2.5 py-1.5 text-xs gap-2"
            disabled={!canSplit}
            onSelect={() => onSplitPane(node.id, "row", false)}
          >
            Split Right
          </ContextMenuItem>
          {splitDisabledReason && (
            <>
              <ContextMenuSeparator />
              <ContextMenuLabel className="px-2.5 py-1 text-[11px] font-normal leading-snug">
                {splitDisabledReason}
              </ContextMenuLabel>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            className="rounded-xl px-2.5 py-1.5 text-xs gap-2"
            variant="destructive"
            onSelect={() => onClosePane(node.id)}
          >
            Close Pane
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
    >
      {node.children.map((child, i) => (
        // Keyed by the subtree's first leaf, not the node id: when a leaf is
        // split in place, the replacing split node gets a fresh id and would
        // otherwise remount the surviving pane.
        <Fragment key={leafIds(child)[0]}>
          {i > 0 && <ResizableHandle />}
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneTreeView {...props} node={child} />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
}

function DropOverlay({ leafId }: { leafId: number }) {
  const { t } = useTranslation("terminal");
  const active = useTerminalDropStore((s) => s.targetLeafId === leafId);
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-lg border border-primary/45 bg-background/70 text-xs font-medium text-foreground shadow-lg backdrop-blur-sm">
      {t("dropFilePathHere")}
    </div>
  );
}
