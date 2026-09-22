import { describe, expect, it } from "vitest";
import type { SpaceMeta } from "@/modules/spaces";
import type {
  EditorTab,
  MarkdownTab,
  Tab,
  TerminalTab,
  WorkbenchState,
} from "@/modules/workbench";
import {
  buildOpenFileGroups,
  filterOpenFileGroups,
} from "@/modules/ai/lib/openFileCandidates";

const workspace = { kind: "local" as const };

function space(id: string, name: string): SpaceMeta {
  return {
    id,
    name,
    root: null,
    rootLocked: false,
    autoName: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function state(tabsBySpace: Record<string, Tab[]>): WorkbenchState {
  const tabs = Object.values(tabsBySpace).flat();
  return {
    tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
    spaces: Object.fromEntries(
      Object.entries(tabsBySpace).map(([spaceId, spaceTabs], index) => {
        const groupId = index + 1;
        return [
          spaceId,
          {
            root: { kind: "group" as const, id: groupId, groupId },
            activeGroupId: groupId,
            groups: {
              [groupId]: {
                id: groupId,
                tabIds: spaceTabs.map((tab) => tab.id),
                activeTabId: spaceTabs[0]?.id ?? null,
              },
            },
          },
        ];
      }),
    ),
  };
}

function editor(id: number, spaceId: string, path: string): EditorTab {
  return {
    id,
    spaceId,
    path,
    title: path,
    kind: "editor",
    dirty: false,
    preview: false,
  };
}

function markdown(id: number, spaceId: string, path: string): MarkdownTab {
  return {
    ...editor(id, spaceId, path),
    kind: "markdown",
  };
}

function terminal(id: number, spaceId: string): TerminalTab {
  return { id, spaceId, title: "Terminal", kind: "terminal" };
}

describe("open file candidates", () => {
  it("orders the current space first, default last, and deduplicates by path", () => {
    const workbench = state({
      default: [
        editor(1, "default", "C:/repo/default.ts"),
        editor(5, "default", "C:/repo/shared.ts"),
      ],
      alpha: [
        editor(2, "alpha", "C:/repo/alpha.ts"),
        editor(7, "alpha", "C:/repo/shared.ts"),
        markdown(3, "alpha", "C:/repo/shared.ts"),
        terminal(6, "alpha"),
      ],
      beta: [editor(4, "beta", "C:/repo/beta.ts")],
    });
    const alpha = workbench.spaces.alpha;
    const activeGroup = alpha?.groups[alpha.activeGroupId];
    if (activeGroup) activeGroup.activeTabId = 3;

    const groups = buildOpenFileGroups({
      state: workbench,
      spaces: [
        space("default", "Default"),
        space("beta", "Beta"),
        space("alpha", "Alpha"),
      ],
      activeSpaceId: "alpha",
      workspace,
    });

    expect(groups.map((group) => group.spaceId)).toEqual([
      "alpha",
      "beta",
      "default",
    ]);
    expect(groups[0]?.files.map((file) => file.name)).toEqual([
      "alpha.ts",
      "shared.ts",
    ]);
    expect(groups[0]?.files[1]?.active).toBe(true);
    expect(groups[2]?.files.map((file) => file.name)).toEqual(["default.ts"]);
  });

  it("keeps default first when it is the current space", () => {
    const workbench = state({
      default: [editor(1, "default", "/repo/default.ts")],
      alpha: [editor(2, "alpha", "/repo/alpha.ts")],
    });

    const groups = buildOpenFileGroups({
      state: workbench,
      spaces: [space("default", "Default"), space("alpha", "Alpha")],
      activeSpaceId: "default",
      workspace,
    });

    expect(groups.map((group) => group.spaceId)).toEqual(["default", "alpha"]);
  });

  it("filters only by file name and removes empty groups", () => {
    const groups = [
      {
        spaceId: "alpha",
        name: "Alpha",
        current: true,
        files: [
          {
            path: "/readers/button.ts",
            name: "button.ts",
            active: false,
          },
          {
            path: "/docs/README.md",
            name: "README.md",
            active: true,
          },
        ],
      },
      {
        spaceId: "beta",
        name: "Beta",
        current: false,
        files: [
          {
            path: "/beta/server.ts",
            name: "server.ts",
            active: false,
          },
        ],
      },
    ];

    expect(filterOpenFileGroups(groups, "READ")).toEqual([
      { ...groups[0], files: [groups[0].files[1]] },
    ]);
    expect(filterOpenFileGroups(groups, "readers")).toEqual([]);
  });
});
