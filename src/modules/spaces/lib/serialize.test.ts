import {
  hydrateSpaceWorkbench,
  isSerializedWorkbenchNode,
  serializeSpaceWorkbench,
} from "@/modules/spaces/lib/serialize";
import type { Tab, WorkbenchState } from "@/modules/workbench";
import { describe, expect, it } from "vitest";

function counter(start = 100): () => number {
  let value = start;
  return () => value++;
}

function state(): WorkbenchState {
  const terminal: Tab = {
    id: 1,
    terminalId: 10,
    kind: "terminal",
    spaceId: "default",
    title: "api",
    cwd: "/work/api",
    customTitle: "api",
  };
  const editor: Tab = {
    id: 2,
    kind: "editor",
    spaceId: "default",
    title: "main.ts",
    path: "/work/main.ts",
    explorerRoot: "/work",
    dirty: false,
    preview: false,
  };
  return {
    tabs: { 1: terminal, 2: editor },
    spaces: {
      default: {
        root: {
          kind: "split",
          id: 20,
          axis: "row",
          sizes: [35, 65],
          children: [
            { kind: "group", id: 21, groupId: 30 },
            { kind: "group", id: 22, groupId: 31 },
          ],
        },
        groups: {
          30: { id: 30, tabIds: [1], activeTabId: 1 },
          31: { id: 31, tabIds: [2], activeTabId: 2 },
        },
        activeGroupId: 31,
      },
    },
  };
}

describe("Workbench Space serialization", () => {
  it("round-trips layout, active group, tabs, and terminal cwd", () => {
    const serialized = serializeSpaceWorkbench(state(), "default");
    expect(serialized).toMatchObject({
      kind: "split",
      axis: "row",
      sizes: [35, 65],
    });
    if (!serialized) throw new Error("missing serialized Workbench");
    const restored = hydrateSpaceWorkbench(serialized, "default", counter());
    expect(restored?.space.root).toMatchObject({
      kind: "split",
      axis: "row",
      sizes: [35, 65],
    });
    expect(restored?.tabs.map((tab) => tab.kind)).toEqual([
      "terminal",
      "editor",
    ]);
    expect(restored?.tabs[0]).toMatchObject({
      kind: "terminal",
      cwd: "/work/api",
      customTitle: "api",
      cold: true,
    });
    const active = restored?.space.groups[restored.space.activeGroupId];
    expect(
      restored?.tabs.find((tab) => tab.id === active?.activeTabId)?.kind,
    ).toBe("editor");
  });

  it("drops private and transient pages and collapses empty branches", () => {
    const current = state();
    current.tabs[1] = { ...current.tabs[1], private: true } as Tab;
    const serialized = serializeSpaceWorkbench(current, "default");
    expect(serialized).toMatchObject({ kind: "group" });
  });

  it("rejects the old flat Space state shape", () => {
    expect(isSerializedWorkbenchNode({ tabs: [], activeTabIndex: 0 })).toBe(
      false,
    );
  });

  it("rejects invalid active flags and panel sizes", () => {
    const group = {
      kind: "group",
      tabs: [{ kind: "terminal" }],
      activeTabIndex: 0,
    };
    expect(isSerializedWorkbenchNode({ ...group, active: "yes" })).toBe(false);
    expect(
      isSerializedWorkbenchNode({
        kind: "split",
        axis: "row",
        children: [group, group],
        sizes: [100, -1],
      }),
    ).toBe(false);
  });
});
