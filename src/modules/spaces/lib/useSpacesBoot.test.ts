/**
 * 本文件测试 Workspace 启动时的环境初始化顺序。
 * 重点锁定空远端 Workspace 不等待连接，而待恢复页面仍会等待环境就绪。
 */

import { describe, expect, it, vi } from "vitest";
import type { SerializedWorkbenchNode } from "./serialize";
import type { LoadedSpaces } from "./store";
import {
  foregroundIntentForLoadedSpaces,
  prepareWorkspaceBoot,
} from "./useSpacesBoot";

/** 创建包含指定持久化布局的测试状态。 */
function loaded(
  workbench: SerializedWorkbenchNode | null,
  referenced = true,
): LoadedSpaces {
  return {
    spaces: referenced
      ? [
          {
            id: "default",
            name: "Default",
            root: null,
            createdAt: 0,
            updatedAt: 0,
          },
        ]
      : [],
    activeId: referenced ? "default" : null,
    states: new Map([["default", { version: 2, workbench }]]),
  };
}

const terminalWorkbench: SerializedWorkbenchNode = {
  kind: "group",
  tabs: [{ kind: "terminal" }],
  activeTabIndex: 0,
};

describe("prepareWorkspaceBoot", () => {
  it("restores an empty remote Workspace without waiting for its environment", async () => {
    const order: string[] = [];
    const ensureReady = vi.fn(async () => {
      order.push("environment");
      return "/home/remote";
    });
    const load = vi.fn(async () => {
      order.push("spaces");
      return loaded(null);
    });

    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      null,
      ensureReady,
      load,
    );

    expect(order).toEqual(["spaces"]);
    expect(ensureReady).not.toHaveBeenCalled();
    expect(prepared).not.toBeNull();
  });

  it("keeps Local Home initialization eager without blocking its empty state", async () => {
    const ensureReady = vi.fn(async () => null);

    const prepared = await prepareWorkspaceBoot(
      { kind: "local" },
      null,
      ensureReady,
      async () => loaded(null),
    );

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(prepared).not.toBeNull();
  });

  it("initializes a remote environment after finding persisted pages", async () => {
    const order: string[] = [];
    const ensureReady = vi.fn(async () => {
      order.push("environment");
      return "/home/remote";
    });
    const load = vi.fn(async () => {
      order.push("spaces");
      return loaded(terminalWorkbench);
    });

    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      null,
      ensureReady,
      load,
    );

    expect(order).toEqual(["spaces", "environment"]);
    expect(prepared).not.toBeNull();
  });

  it("ignores orphaned persisted pages", async () => {
    const ensureReady = vi.fn(async () => "/home/remote");

    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      null,
      ensureReady,
      async () => loaded(terminalWorkbench, false),
    );

    expect(prepared?.states.size).toBe(0);
    expect(ensureReady).not.toHaveBeenCalled();
  });

  it("does not restore remote pages when home resolution fails", async () => {
    const load = vi.fn(async () => loaded(terminalWorkbench));

    const prepared = await prepareWorkspaceBoot(
      { kind: "wsl", distro: "Ubuntu" },
      null,
      async () => null,
      load,
    );

    expect(prepared).toBeNull();
    expect(load).toHaveBeenCalledOnce();
  });

  it("reuses a home resolved by an interactive retry", async () => {
    const ensureReady = vi.fn(async () => "/unused");
    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      "/srv/work",
      ensureReady,
      async () => loaded(terminalWorkbench),
    );

    expect(ensureReady).not.toHaveBeenCalled();
    expect(prepared).not.toBeNull();
  });

  it("does not block layout restoration when the foreground hint fails", async () => {
    const ensureReady = vi.fn(async () => "/home/remote");

    const prepared = await prepareWorkspaceBoot(
      { kind: "ssh", profileId: "server" },
      null,
      ensureReady,
      async () => loaded(terminalWorkbench),
      async () => {
        throw new Error("IPC unavailable");
      },
    );

    expect(ensureReady).toHaveBeenCalledOnce();
    expect(prepared).not.toBeNull();
  });
});

describe("foregroundIntentForLoadedSpaces", () => {
  it("reports the explicitly active terminal before waiting for SSH", () => {
    const workbench: SerializedWorkbenchNode = {
      kind: "split",
      axis: "row",
      children: [
        {
          kind: "group",
          tabs: [{ kind: "editor", path: "/srv/a.ts" }],
          activeTabIndex: 0,
        },
        {
          kind: "group",
          tabs: [{ kind: "terminal", cwd: "/srv/project", blocks: true }],
          activeTabIndex: 0,
          active: true,
        },
      ],
    };

    expect(foregroundIntentForLoadedSpaces(loaded(workbench))).toEqual({
      kind: "terminal",
      cwd: "/srv/project",
      blocks: true,
    });
  });

  it("prioritizes Explorer when the active page is not a terminal", () => {
    const workbench: SerializedWorkbenchNode = {
      kind: "group",
      tabs: [{ kind: "editor", path: "/srv/a.ts" }],
      activeTabIndex: 0,
      active: true,
    };

    expect(foregroundIntentForLoadedSpaces(loaded(workbench))).toEqual({
      kind: "explorer",
    });
  });
});
