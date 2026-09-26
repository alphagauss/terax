import { SIDEBAR_CONTAINERS } from "@/modules/sidebar/containers";
import { describe, expect, it } from "vitest";
import { getPrimaryNavigationActiveId as resolveActiveId } from "./primaryNavigation";

const getPrimaryNavigationActiveId = (
  primary: Parameters<typeof resolveActiveId>[0],
  kind: Parameters<typeof resolveActiveId>[1],
) => resolveActiveId(primary, kind, SIDEBAR_CONTAINERS);

describe("主活动栏选中状态", () => {
  it("应用高亮由入口声明决定，并且只匹配当前可用入口", () => {
    const primary = { activeId: "explorer", collapsed: true } as const;
    const application = {
      ...SIDEBAR_CONTAINERS[1],
      opensPage: "editor",
    } as const;
    expect(resolveActiveId(primary, "editor", [application])).toBe("search");
    expect(
      resolveActiveId({ ...primary, collapsed: false }, "editor", [
        application,
      ]),
    ).toBe("explorer");
    expect(resolveActiveId(primary, "alpha-desk", [application])).toBeNull();
    expect(resolveActiveId(primary, "editor", [])).toBeNull();
    expect(resolveActiveId(primary, undefined, SIDEBAR_CONTAINERS)).toBeNull();
  });

  it("Alpha 页面中打开其他侧栏后转移高亮，收起侧栏后恢复 Alpha 高亮", () => {
    const primary = { activeId: "explorer", collapsed: true } as const;
    expect(getPrimaryNavigationActiveId(primary, "alpha-desk")).toBe("alpha");

    for (const activeId of ["explorer", "search", "source-control"] as const) {
      expect(
        getPrimaryNavigationActiveId(
          { activeId, collapsed: false },
          "alpha-desk",
        ),
      ).toBe(activeId);
      expect(
        getPrimaryNavigationActiveId(
          { activeId, collapsed: true },
          "alpha-desk",
        ),
      ).toBe("alpha");
    }
  });

  it("离开 Alpha 后仅高亮展开的侧栏，空工作页遵循相同规则", () => {
    for (const kind of ["editor", "terminal", undefined] as const) {
      expect(
        getPrimaryNavigationActiveId(
          { activeId: "search", collapsed: false },
          kind,
        ),
      ).toBe("search");
      expect(
        getPrimaryNavigationActiveId(
          { activeId: "search", collapsed: true },
          kind,
        ),
      ).toBeNull();
    }
  });
});
