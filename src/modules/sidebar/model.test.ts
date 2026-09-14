/**
 * 本文件测试统一侧边栏布局模型。
 * 重点锁定容器唯一归属、跨位置移动、损坏状态修复和新默认容器补全。
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIDEBAR_PLACEMENT_STATE,
  DEFAULT_SIDEBAR_RUNTIME_STATE,
  findSidebarContainerLocation,
  moveSidebarContainer,
  normalizeSidebarPlacementState,
  normalizeSidebarRuntimeState,
  runtimeAfterSidebarContainerMove,
} from "./model";

describe("normalizeSidebarPlacementState", () => {
  it("repairs duplicates, unknown ids, and missing containers", () => {
    expect(
      normalizeSidebarPlacementState({
        version: 1,
        placements: {
          primary: ["ai", "ai", "missing"],
          secondary: ["explorer"],
        },
      }),
    ).toEqual({
      version: 1,
      placements: {
        primary: ["ai", "search", "source-control", "alpha"],
        secondary: ["explorer", "channels"],
      },
      activityBar: {
        position: "default",
        size: "default",
        hiddenContainerIds: [],
      },
    });
  });

  it("uses the current defaults for unsupported versions", () => {
    expect(
      normalizeSidebarPlacementState({
        version: 0,
        placements: { primary: ["ai"], secondary: [] },
      }),
    ).toEqual(DEFAULT_SIDEBAR_PLACEMENT_STATE);
  });

  it("将新增搜索容器插入文件管理器后面", () => {
    expect(
      normalizeSidebarPlacementState({
        version: 1,
        placements: {
          primary: ["explorer", "source-control", "alpha"],
          secondary: ["ai"],
        },
      }).placements.primary,
    ).toEqual(["explorer", "search", "source-control", "alpha"]);
  });

  it("normalizes activity bar settings and hidden containers", () => {
    expect(
      normalizeSidebarPlacementState({
        version: 1,
        placements: DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
        activityBar: {
          position: "bottom",
          size: "compact",
          hiddenContainerIds: ["ai", "ai", "missing"],
        },
      }).activityBar,
    ).toEqual({
      position: "bottom",
      size: "compact",
      hiddenContainerIds: ["ai"],
    });
  });
});

describe("moveSidebarContainer", () => {
  it("moves a container across locations at the requested gap", () => {
    const placements = moveSidebarContainer(
      DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
      "source-control",
      "secondary",
      0,
    );

    expect(placements).toEqual({
      primary: ["explorer", "search", "alpha"],
      secondary: ["source-control", "ai", "channels"],
    });
    expect(findSidebarContainerLocation(placements, "source-control")).toBe(
      "secondary",
    );
  });

  it("reorders without duplicating the source container", () => {
    const placements = moveSidebarContainer(
      DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
      "explorer",
      "primary",
      1,
    );

    expect(placements.primary).toEqual([
      "search",
      "explorer",
      "source-control",
      "alpha",
    ]);
  });

  it("returns the original placements when the requested order is unchanged", () => {
    const placements = DEFAULT_SIDEBAR_PLACEMENT_STATE.placements;
    expect(moveSidebarContainer(placements, "explorer", "primary", 0)).toBe(
      placements,
    );
  });
});

describe("normalizeSidebarRuntimeState", () => {
  it("selects a valid fallback and clamps widths", () => {
    expect(
      normalizeSidebarRuntimeState(
        {
          version: 1,
          primary: {
            activeId: "ai",
            collapsed: false,
            width: 20,
          },
          secondary: {
            activeId: "missing",
            collapsed: false,
            width: 30,
          },
        },
        DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
      ),
    ).toEqual({
      version: 1,
      primary: {
        activeId: "explorer",
        collapsed: false,
        width: 180,
      },
      secondary: {
        activeId: "ai",
        collapsed: false,
        width: 280,
      },
      secondaryMaximized: false,
    });
  });

  it("does not keep an individually hidden container active", () => {
    expect(
      normalizeSidebarRuntimeState(
        DEFAULT_SIDEBAR_RUNTIME_STATE,
        DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
        ["explorer", "ai", "channels"],
      ),
    ).toMatchObject({
      primary: { activeId: "search", collapsed: false },
      secondary: { activeId: null, collapsed: true },
    });
  });

  it("keeps maximization only while the secondary sidebar is open", () => {
    const open = normalizeSidebarRuntimeState(
      {
        ...DEFAULT_SIDEBAR_RUNTIME_STATE,
        secondary: {
          ...DEFAULT_SIDEBAR_RUNTIME_STATE.secondary,
          collapsed: false,
        },
        secondaryMaximized: true,
      },
      DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
    );
    expect(open.secondaryMaximized).toBe(true);
    expect(
      normalizeSidebarRuntimeState(
        {
          ...DEFAULT_SIDEBAR_RUNTIME_STATE,
          secondaryMaximized: true,
        },
        DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
      ).secondaryMaximized,
    ).toBe(false);
  });
});

describe("runtimeAfterSidebarContainerMove", () => {
  it("preserves the active container for same-sidebar reordering", () => {
    const nextPlacements = moveSidebarContainer(
      DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
      "source-control",
      "primary",
      0,
    );
    expect(
      runtimeAfterSidebarContainerMove(
        DEFAULT_SIDEBAR_RUNTIME_STATE,
        DEFAULT_SIDEBAR_PLACEMENT_STATE.placements,
        nextPlacements,
        "source-control",
        "primary",
      ),
    ).toBe(DEFAULT_SIDEBAR_RUNTIME_STATE);
  });

  it("activates a cross-sidebar move and skips hidden source fallbacks", () => {
    const previousPlacements = DEFAULT_SIDEBAR_PLACEMENT_STATE.placements;
    const nextPlacements = moveSidebarContainer(
      previousPlacements,
      "explorer",
      "secondary",
      1,
    );
    expect(
      runtimeAfterSidebarContainerMove(
        DEFAULT_SIDEBAR_RUNTIME_STATE,
        previousPlacements,
        nextPlacements,
        "explorer",
        "secondary",
        ["source-control"],
      ),
    ).toEqual({
      version: 1,
      primary: {
        activeId: "search",
        collapsed: false,
        width: 260,
      },
      secondary: {
        activeId: "explorer",
        collapsed: false,
        width: 360,
      },
      secondaryMaximized: false,
    });
  });
});
