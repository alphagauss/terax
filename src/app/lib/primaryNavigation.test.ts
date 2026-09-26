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
    expect(resolveActiveId(primary, "terminal", [application])).toBeNull();
    expect(resolveActiveId(primary, "editor", [])).toBeNull();
    expect(resolveActiveId(primary, undefined, SIDEBAR_CONTAINERS)).toBeNull();
  });

  it("普通工作页仅高亮展开的侧栏，空工作页遵循相同规则", () => {
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
