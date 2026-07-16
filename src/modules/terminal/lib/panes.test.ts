import { describe, expect, it } from "vitest";
import {
  findLeafCwd,
  leafIds,
  removeLeaf,
  splitLeaf,
  type PaneNode,
} from "./panes";

const leaf = (id: number, cwd?: string): PaneNode => ({
  kind: "leaf",
  id,
  cwd,
});

describe("splitLeaf", () => {
  it("inserts before or after a sibling in the same-direction split", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [leaf(1), leaf(2)],
    };

    expect(leafIds(splitLeaf(tree, 2, 20, 3, "row", "/before", true))).toEqual([
      1, 3, 2,
    ]);
    expect(leafIds(splitLeaf(tree, 2, 20, 3, "row", "/after"))).toEqual([
      1, 2, 3,
    ]);
  });

  it("preserves the requested order when wrapping a leaf", () => {
    const tree = leaf(1, "/source");

    const result = splitLeaf(tree, 1, 10, 2, "col", "/target", true);

    expect(leafIds(result)).toEqual([2, 1]);
    expect(findLeafCwd(result, 2)).toBe("/target");
    expect(findLeafCwd(result, 1)).toBe("/source");
  });
});

describe("pane tree removal", () => {
  it("collapses the split after removing its last sibling", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [leaf(1), leaf(2)],
    };

    expect(removeLeaf(tree, 1)).toEqual(leaf(2));
    expect(removeLeaf(tree, 2)).toEqual(leaf(1));
  });
});
