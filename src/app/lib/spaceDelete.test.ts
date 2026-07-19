import type { Tab } from "@/modules/workbench";
import { describe, expect, it } from "vitest";
import { spaceDeleteDocuments } from "./spaceDelete";

describe("Space deletion document lifecycle", () => {
  it("guards and discards only documents losing their final view", () => {
    const tabs: Tab[] = [
      {
        id: 1,
        kind: "editor",
        spaceId: "deleted",
        title: "shared.ts",
        path: "C:\\work\\shared.ts",
        dirty: true,
        preview: false,
      },
      {
        id: 2,
        kind: "markdown",
        spaceId: "deleted",
        title: "orphan.md",
        path: "C:\\work\\orphan.md",
        dirty: true,
      },
      {
        id: 3,
        kind: "editor",
        spaceId: "kept",
        title: "shared.ts",
        path: "C:\\work\\shared.ts",
        dirty: true,
        preview: false,
      },
    ];

    expect(spaceDeleteDocuments(tabs, "deleted", { kind: "local" })).toEqual({
      dirtyDocuments: 1,
      discardPaths: ["C:\\work\\orphan.md"],
    });
  });
});
