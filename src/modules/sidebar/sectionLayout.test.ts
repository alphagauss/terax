import { describe, expect, it } from "vitest";
import { normalizeSidebarSectionLayout } from "./sectionLayout";

const configs = [
  { id: "changes", defaultSize: 320, minSize: 160 },
  {
    id: "graph",
    defaultSize: 220,
    minSize: 100,
    defaultCollapsed: true,
  },
] as const;

describe("normalizeSidebarSectionLayout", () => {
  it("uses section defaults when no saved layout exists", () => {
    expect(normalizeSidebarSectionLayout(undefined, configs)).toEqual({
      version: 1,
      sections: {
        changes: { size: 320, collapsed: false },
        graph: { size: 220, collapsed: true },
      },
    });
  });

  it("restores known sections and clamps undersized values", () => {
    expect(
      normalizeSidebarSectionLayout(
        {
          version: 1,
          sections: {
            changes: { size: 120.4, collapsed: true },
            graph: { size: 280.7, collapsed: false },
            removed: { size: 999, collapsed: false },
          },
        },
        configs,
      ),
    ).toEqual({
      version: 1,
      sections: {
        changes: { size: 160, collapsed: true },
        graph: { size: 281, collapsed: false },
      },
    });
  });

  it("rejects malformed and old layouts", () => {
    expect(
      normalizeSidebarSectionLayout(
        { version: 0, sections: { graph: { size: 500, collapsed: false } } },
        configs,
      ),
    ).toEqual(normalizeSidebarSectionLayout(null, configs));
  });
});
