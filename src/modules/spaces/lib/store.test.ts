import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceStore = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  set: vi.fn(async (key: string, value: unknown) => {
    workspaceStore.entries.set(key, value);
  }),
  remove: vi.fn(async (key: string) => {
    workspaceStore.entries.delete(key);
  }),
}));

vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceEntries: () => new Map(workspaceStore.entries),
  setWorkspaceValue: workspaceStore.set,
  deleteWorkspaceValue: workspaceStore.remove,
}));

import {
  hydrateSpaceWorkbench,
  type SerializedWorkbenchNode,
} from "./serialize";
import { deleteSpaceData, loadAll, saveState } from "./store";

const workbench: SerializedWorkbenchNode = {
  kind: "split",
  axis: "row",
  sizes: [30, 70],
  children: [
    {
      kind: "group",
      tabs: [{ kind: "terminal", cwd: "/work", customTitle: "api" }],
      activeTabIndex: 0,
    },
    {
      kind: "group",
      tabs: [
        { kind: "markdown", path: "/work/README.md", explorerRoot: "/work" },
        { kind: "web-preview", url: "http://localhost:5173" },
      ],
      activeTabIndex: 1,
      active: true,
    },
  ],
};

describe("Workbench v2 storage boundary", () => {
  beforeEach(() => {
    workspaceStore.entries.clear();
    vi.clearAllMocks();
  });

  it("saves, loads, and hydrates the current v2 state", async () => {
    await saveState("space-a", { version: 2, workbench });
    const loaded = await loadAll();
    const persisted = loaded.states.get("space-a");
    expect(persisted).toEqual({ version: 2, workbench });

    let id = 1;
    const restored = persisted
      ? hydrateSpaceWorkbench(persisted.workbench, "space-a", () => id++)
      : null;
    expect(restored?.space.root).toMatchObject({
      kind: "split",
      axis: "row",
      sizes: [30, 70],
    });
    expect(restored?.tabs.map((tab) => tab.kind)).toEqual([
      "terminal",
      "markdown",
      "web-preview",
    ]);
    const active = restored?.space.groups[restored.space.activeGroupId];
    expect(
      restored?.tabs.find((tab) => tab.id === active?.activeTabId),
    ).toMatchObject({
      kind: "web-preview",
      url: "http://localhost:5173",
    });
  });

  it("does not load old versions or the old preview discriminator", async () => {
    workspaceStore.entries.set("spaceState:old-version", {
      version: 1,
      workbench,
    });
    workspaceStore.entries.set("spaceState:old-preview", {
      version: 2,
      workbench: {
        kind: "group",
        tabs: [{ kind: "preview", url: "http://localhost:5173" }],
        activeTabIndex: 0,
      },
    });

    const loaded = await loadAll();
    expect(loaded.states.size).toBe(0);
  });

  it("serializes save and delete operations for one Space", async () => {
    let releaseFirst: (() => void) | undefined;
    workspaceStore.set.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }),
    );

    const saving = saveState("space-a", { version: 2, workbench });
    const deleting = deleteSpaceData("space-a");
    await Promise.resolve();
    expect(workspaceStore.set).toHaveBeenCalledTimes(1);
    expect(workspaceStore.remove).not.toHaveBeenCalled();

    releaseFirst?.();
    await saving;
    await deleting;
    expect(workspaceStore.remove).toHaveBeenCalledWith("spaceState:space-a");
  });

  it("continues a Space queue after a failed write", async () => {
    workspaceStore.set.mockRejectedValueOnce(new Error("write failed"));
    const failed = saveState("space-a", { version: 2, workbench });
    const deleting = deleteSpaceData("space-a");

    await expect(failed).rejects.toThrow("write failed");
    await expect(deleting).resolves.toBeUndefined();
    expect(workspaceStore.remove).toHaveBeenCalledWith("spaceState:space-a");
  });
});
