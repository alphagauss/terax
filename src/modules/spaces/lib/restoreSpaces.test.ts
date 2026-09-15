// @vitest-environment happy-dom
/** 恢复真实 Space 元数据与空布局时，根目录授权不依赖终端页面存在。 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { WorkbenchState } from "@/modules/workbench/types";

const mocks = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
  authorize: vi.fn(async () => "/project"),
  replace: vi.fn(),
  booted: vi.fn(),
}));
vi.mock("@/modules/workspace-process", () => ({
  getWorkspaceEntries: () => new Map(mocks.entries),
  setWorkspaceValue: vi.fn(async () => {}),
  deleteWorkspaceValue: vi.fn(async () => {}),
  currentWorkspaceBootstrap: () => ({ launchDir: null }),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => ({ kind: "local" }),
}));
vi.mock("@/modules/ai/lib/native", () => ({
  native: { workspaceAuthorize: mocks.authorize },
}));
vi.mock("@/modules/alpha/preferences", () => ({
  getInitialAlphaShowInRemote: () => false,
}));
vi.mock("@/modules/remote", () => ({
  remoteNative: { setForeground: vi.fn() },
}));
import { createDefaultSpace, useSpaces } from "./useSpaces";
import { useSpacesBoot } from "./useSpacesBoot";

it.each([true, false])(
  "restores an empty space with rootLocked=%s without accessing inactive roots",
  async (rootLocked) => {
    vi.clearAllMocks();
    const project = {
      ...createDefaultSpace(),
      id: "project",
      root: "/project",
      rootLocked,
      autoName: false,
      name: "My project",
    };
    mocks.entries.set("spaces", [project, createDefaultSpace()]);
    mocks.entries.set("activeSpaceId", project.id);
    mocks.entries.set("spaceState:project", { version: 2, workbench: null });
    let id = 0;
    const allocId = () => ++id;
    const ready = async () => "/home";
    function Harness() {
      useSpacesBoot({
        ready: true,
        allocId,
        replaceWorkbench: mocks.replace,
        markBooted: mocks.booted,
        ensureWorkspaceReady: ready,
        environmentHome: "/home",
      });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      await act(async () => root.render(createElement(Harness)));
      if (rootLocked)
        expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith("/project");
      else expect(mocks.authorize).not.toHaveBeenCalled();
      expect(mocks.replace).toHaveBeenCalledOnce();
      const restored = mocks.replace.mock.calls[0][0] as WorkbenchState;
      expect(restored.tabs).toEqual({});
      expect(Object.keys(restored.spaces)).toEqual(["default", "project"]);
      expect(useSpaces.getState().spaces[1]).toEqual(project);
      expect(useSpaces.getState().activeId).toBe("project");
      if (rootLocked)
        expect(mocks.authorize.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.replace.mock.invocationCallOrder[0],
        );
    } finally {
      await act(async () => root.unmount());
    }
  },
);
